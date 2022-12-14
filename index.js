'use strict'

/* global __coverage__ */

const arrify = require('arrify')
const cachingTransform = require('caching-transform')
const util = require('util')
const findCacheDir = require('find-cache-dir')
const fs = require('fs')
const glob = require('glob')
const Hash = require('./lib/hash')
const libCoverage = require('istanbul-lib-coverage')
const libHook = require('istanbul-lib-hook')
const mkdirp = require('make-dir')
const Module = require('module')
const onExit = require('signal-exit')
const path = require('path')
const resolveFrom = require('resolve-from')
const rimraf = require('rimraf')
const SourceMaps = require('./lib/source-maps')
const testExclude = require('test-exclude')
const uuid = require('uuid/v4')
const api = require('istanbul-api')

const debugLog = util.debuglog('nyc')

const ProcessInfo = require('./lib/process.js')

/* istanbul ignore next */
if (/self-coverage/.test(__dirname)) {
  require('../self-coverage-helper')
}

function NYC (config) {
  config = config || {}
  this.config = config

  this.subprocessBin =
    config.subprocessBin || path.resolve(__dirname, './bin/nyc.js')
  this._tempDirectory =
    config.tempDirectory || config.tempDir || './.nyc_output'
  this._instrumenterLib = require(config.instrumenter ||
    './lib/instrumenters/istanbul')
  this._reportDir = config.reportDir || 'coverage'
  this._sourceMap =
    typeof config.sourceMap === 'boolean' ? config.sourceMap : true
  this._showProcessTree = config.showProcessTree || false
  this._eagerInstantiation = config.eager || false
  this.cwd = config.cwd || process.cwd()
  this.reporter = arrify(config.reporter || 'text')

  this.cacheDirectory =
    (config.cacheDir && path.resolve(config.cacheDir)) ||
    findCacheDir({ name: 'nyc', cwd: this.cwd })
  this.cache = Boolean(this.cacheDirectory && config.cache)

  this.exclude = testExclude({
    cwd: this.cwd,
    include: config.include,
    exclude: config.exclude
  })

  this.sourceMaps = new SourceMaps({
    cache: this.cache,
    cacheDirectory: this.cacheDirectory
  })

  // require extensions can be provided as config in package.json.
  this.require = arrify(config.require)

  this.extensions = arrify(config.extension)
    .concat('.js')
    .map(function (ext) {
      return ext.toLowerCase()
    })
    .filter(function (item, pos, arr) {
      // avoid duplicate extensions
      return arr.indexOf(item) === pos
    })

  this.transforms = this.extensions.reduce(
    function (transforms, ext) {
      transforms[ext] = this._createTransform(ext)
      return transforms
    }.bind(this),
    {}
  )

  this.hookRequire = config.hookRequire
  this.hookRunInContext = config.hookRunInContext
  this.hookRunInThisContext = config.hookRunInThisContext
  this.fakeRequire = null

  this.processInfo = new ProcessInfo(config && config._processInfo)
  this.rootId = this.processInfo.root || this.generateUniqueID()

  this.hashCache = {}

  this.config.reporting = config.reporting || {}
  this.config.reporting['dir'] = this.reportDirectory()
  this.config.reporting['report-config'] = this._reportConfig()
  this.config.reporting['summarizer'] = this._reportSummarizer()
  this.config.reporting['watermarks'] = this._reportWatermarks()
}

NYC.prototype._createTransform = function (ext) {
  var opts = {
    salt: Hash.salt(this.config),
    hashData: (input, metadata) => [metadata.filename],
    onHash: (input, metadata, hash) => {
      this.hashCache[metadata.filename] = hash
    },
    cacheDir: this.cacheDirectory,
    // when running --all we should not load source-file from
    // cache, we want to instead return the fake source.
    disableCache: this._disableCachingTransform(),
    ext: ext
  }
  if (this._eagerInstantiation) {
    opts.transform = this._transformFactory(this.cacheDirectory)
  } else {
    opts.factory = this._transformFactory.bind(this)
  }
  return cachingTransform(opts)
}

NYC.prototype._disableCachingTransform = function () {
  return !(this.cache && this.config.isChildProcess)
}

NYC.prototype._loadAdditionalModules = function () {
  var _this = this
  this.require.forEach(function (r) {
    // first attempt to require the module relative to
    // the directory being instrumented.
    var p = resolveFrom.silent(_this.cwd, r)
    if (p) {
      require(p)
      return
    }
    // now try other locations, .e.g, the nyc node_modules folder.
    require(r)
  })
}

NYC.prototype.instrumenter = function () {
  return this._instrumenter || (this._instrumenter = this._createInstrumenter())
}

NYC.prototype._createInstrumenter = function () {
  return this._instrumenterLib(this.cwd, {
    ignoreClassMethods: [].concat(this.config.ignoreClassMethod).filter(a => a),
    produceSourceMap: this.config.produceSourceMap,
    compact: this.config.compact,
    preserveComments: this.config.preserveComments,
    esModules: this.config.esModules,
    plugins: this.config.plugins
  })
}

NYC.prototype.addFile = function (filename) {
  var relFile = path.relative(this.cwd, filename)
  var source = this._readTranspiledSource(path.resolve(this.cwd, filename))
  var instrumentedSource = this._maybeInstrumentSource(
    source,
    filename,
    relFile
  )

  return {
    instrument: !!instrumentedSource,
    relFile: relFile,
    content: instrumentedSource || source
  }
}

NYC.prototype._readTranspiledSource = function (filePath) {
  var source = null
  var ext = path.extname(filePath)
  if (typeof Module._extensions[ext] === 'undefined') {
    ext = '.js'
  }
  Module._extensions[ext](
    {
      _compile: function (content, filename) {
        source = content
      }
    },
    filePath
  )
  return source
}

NYC.prototype.addAllFiles = function () {
  var _this = this

  this._loadAdditionalModules()

  this.fakeRequire = true
  this.walkAllFiles(this.cwd, function (filename) {
    filename = path.resolve(_this.cwd, filename)
    if (_this.exclude.shouldInstrument(filename)) {
      _this.addFile(filename)
      var coverage = coverageFinder()
      var lastCoverage = _this.instrumenter().lastFileCoverage()
      if (lastCoverage) {
        filename = lastCoverage.path
        coverage[filename] = lastCoverage
      }
    }
  })
  this.fakeRequire = false

  this.writeCoverageFile()
}

NYC.prototype.instrumentAllFiles = function (input, output, cb) {
  var _this = this
  var inputDir = '.' + path.sep
  var visitor = function (filename) {
    var ext
    var transform
    var inFile = path.resolve(inputDir, filename)
    var code = fs.readFileSync(inFile, 'utf-8')

    for (ext in _this.transforms) {
      if (filename.toLowerCase().substr(-ext.length) === ext) {
        transform = _this.transforms[ext]
        break
      }
    }

    if (transform) {
      code = transform(code, { filename: filename, relFile: inFile })
    }

    if (!output) {
      console.log(code)
    } else {
      var outFile = path.resolve(output, filename)
      mkdirp.sync(path.dirname(outFile))
      fs.writeFileSync(outFile, code, 'utf-8')
    }
  }

  this._loadAdditionalModules()

  try {
    var stats = fs.lstatSync(input)
    if (stats.isDirectory()) {
      inputDir = input
      this.walkAllFiles(input, visitor)
    } else {
      visitor(input)
    }
  } catch (err) {
    return cb(err)
  }
  cb()
}

NYC.prototype.walkAllFiles = function (dir, visitor) {
  var pattern = null
  if (this.extensions.length === 1) {
    pattern = '**/*' + this.extensions[0]
  } else {
    pattern = '**/*{' + this.extensions.join() + '}'
  }

  glob
    .sync(pattern, { cwd: dir, nodir: true, ignore: this.exclude.exclude })
    .forEach(function (filename) {
      visitor(filename)
    })
}

NYC.prototype._maybeInstrumentSource = function (code, filename, relFile) {
  var instrument = this.exclude.shouldInstrument(filename, relFile)
  if (!instrument) {
    return null
  }

  var ext, transform
  for (ext in this.transforms) {
    if (filename.toLowerCase().substr(-ext.length) === ext) {
      transform = this.transforms[ext]
      break
    }
  }

  return transform
    ? transform(code, { filename: filename, relFile: relFile })
    : null
}

NYC.prototype._transformFactory = function (cacheDir) {
  const instrumenter = this.instrumenter()
  let instrumented

  return (code, metadata, hash) => {
    const filename = metadata.filename
    let sourceMap = null

    if (this._sourceMap) {
      sourceMap = this.sourceMaps.extractAndRegister(code, filename, hash)
    }

    try {
      instrumented = instrumenter.instrumentSync(code, filename, sourceMap)
    } catch (e) {
      debugLog('failed to instrument ' + filename + ' with error: ' + e.stack)
      if (this.config.exitOnError) {
        console.error('Failed to instrument ' + filename)
        process.exit(1)
      } else {
        instrumented = code
      }
    }

    if (this.fakeRequire) {
      return 'function x () {}'
    } else {
      return instrumented
    }
  }
}

NYC.prototype._handleJs = function (code, options) {
  var filename = options.filename
  var relFile = path.relative(this.cwd, filename)
  // ensure the path has correct casing (see istanbuljs/nyc#269 and nodejs/node#6624)
  filename = path.resolve(this.cwd, relFile)
  return this._maybeInstrumentSource(code, filename, relFile) || code
}

NYC.prototype._addHook = function (type) {
  var handleJs = this._handleJs.bind(this)
  var dummyMatcher = function () {
    return true
  } // we do all processing in transformer
  libHook['hook' + type](dummyMatcher, handleJs, {
    extensions: this.extensions
  })
}

NYC.prototype._addRequireHooks = function () {
  if (this.hookRequire) {
    this._addHook('Require')
  }
  if (this.hookRunInContext) {
    this._addHook('RunInContext')
  }
  if (this.hookRunInThisContext) {
    this._addHook('RunInThisContext')
  }
}

NYC.prototype.cleanup = function () {
  if (!process.env.NYC_CWD) rimraf.sync(this.tempDirectory())
}

NYC.prototype.clearCache = function () {
  if (this.cache) {
    rimraf.sync(this.cacheDirectory)
  }
}

NYC.prototype.createTempDirectory = function () {
  mkdirp.sync(this.tempDirectory())
  if (this.cache) mkdirp.sync(this.cacheDirectory)

  if (this._showProcessTree) {
    mkdirp.sync(this.processInfoDirectory())
  }
}

NYC.prototype.reset = function () {
  this.cleanup()
  this.createTempDirectory()
}

NYC.prototype._wrapExit = function () {
  var _this = this

  // we always want to write coverage
  // regardless of how the process exits.
  onExit(
    function () {
      _this.writeCoverageFile()
    },
    { alwaysLast: true }
  )
}

NYC.prototype.wrap = function (bin) {
  this._addRequireHooks()
  this._wrapExit()
  this._loadAdditionalModules()
  return this
}

NYC.prototype.generateUniqueID = uuid

NYC.prototype.writeCoverageFile = function () {
  var coverage = coverageFinder()
  if (!coverage) return

  // Remove any files that should be excluded but snuck into the coverage
  Object.keys(coverage).forEach(function (absFile) {
    if (!this.exclude.shouldInstrument(absFile)) {
      delete coverage[absFile]
    }
  }, this)

  if (this.cache) {
    Object.keys(coverage).forEach(function (absFile) {
      if (this.hashCache[absFile] && coverage[absFile]) {
        coverage[absFile].contentHash = this.hashCache[absFile]
      }
    }, this)
  } else {
    coverage = this.sourceMaps.remapCoverage(coverage)
  }

  var id = this.generateUniqueID()
  var coverageFilename = path.resolve(this.tempDirectory(), id + '.json')

  fs.writeFileSync(coverageFilename, JSON.stringify(coverage), 'utf-8')

  if (!this._showProcessTree) {
    return
  }

  this.processInfo.coverageFilename = coverageFilename

  fs.writeFileSync(
    path.resolve(this.processInfoDirectory(), id + '.json'),
    JSON.stringify(this.processInfo),
    'utf-8'
  )
}

function coverageFinder () {
  var coverage = global.__coverage__
  if (typeof __coverage__ === 'object') coverage = __coverage__
  if (!coverage) coverage = global['__coverage__'] = {}
  return coverage
}

NYC.prototype.getCoverageMapFromAllCoverageFiles = function (baseDirectory) {
  var _this = this
  var map = libCoverage.createCoverageMap({})

  this.eachReport(
    undefined,
    report => {
      map.merge(report)
    },
    baseDirectory
  )
  // depending on whether source-code is pre-instrumented
  // or instrumented using a JIT plugin like @babel/require
  // you may opt to exclude files after applying
  // source-map remapping logic.
  if (this.config.excludeAfterRemap) {
    map.filter(function (filename) {
      return _this.exclude.shouldInstrument(filename)
    })
  }
  map.data = this.sourceMaps.remapCoverage(map.data)
  return map
}

NYC.prototype.report = function () {
  const config = api.config.loadObject(this.config)
  const reporter = api.createReporter(config)
  const map = this.getCoverageMapFromAllCoverageFiles()

  reporter.addAll(this.reporter)
  reporter.write(map)

  if (this._showProcessTree) {
    this.showProcessTree()
  }
}

NYC.prototype.showProcessTree = function () {
  var processTree = ProcessInfo.buildProcessTree(this._loadProcessInfos())

  console.log(processTree.render(this))
}

NYC.prototype.checkCoverage = function (thresholds, perFile) {
  var map = this.getCoverageMapFromAllCoverageFiles()
  var nyc = this

  if (perFile) {
    map.files().forEach(function (file) {
      // ERROR: Coverage for lines (90.12%) does not meet threshold (120%) for index.js
      nyc._checkCoverage(
        map.fileCoverageFor(file).toSummary(),
        thresholds,
        file
      )
    })
  } else {
    // ERROR: Coverage for lines (90.12%) does not meet global threshold (120%)
    nyc._checkCoverage(map.getCoverageSummary(), thresholds)
  }
}

NYC.prototype._checkCoverage = function (summary, thresholds, file) {
  Object.keys(thresholds).forEach(function (key) {
    var coverage = summary[key].pct
    if (coverage < thresholds[key]) {
      process.exitCode = 1
      if (file) {
        console.error(
          'ERROR: Coverage for ' +
            key +
            ' (' +
            coverage +
            '%) does not meet threshold (' +
            thresholds[key] +
            '%) for ' +
            file
        )
      } else {
        console.error(
          'ERROR: Coverage for ' +
            key +
            ' (' +
            coverage +
            '%) does not meet global threshold (' +
            thresholds[key] +
            '%)'
        )
      }
    }
  })
}

NYC.prototype._loadProcessInfos = function () {
  var _this = this
  var files = fs.readdirSync(this.processInfoDirectory())

  return files.map(function (f) {
    try {
      return new ProcessInfo(
        JSON.parse(
          fs.readFileSync(
            path.resolve(_this.processInfoDirectory(), f),
            'utf-8'
          )
        )
      )
    } catch (e) {
      // handle corrupt JSON output.
      return {}
    }
  })
}

NYC.prototype.eachReport = function (filenames, iterator, baseDirectory) {
  baseDirectory = baseDirectory || this.tempDirectory()

  if (typeof filenames === 'function') {
    iterator = filenames
    filenames = undefined
  }

  var _this = this
  var files = filenames || fs.readdirSync(baseDirectory)

  files.forEach(function (f) {
    var report
    try {
      report = JSON.parse(
        fs.readFileSync(path.resolve(baseDirectory, f), 'utf-8')
      )

      _this.sourceMaps.reloadCachedSourceMaps(report)
    } catch (e) {
      // handle corrupt JSON output.
      report = {}
    }

    iterator(report)
  })
}

NYC.prototype.loadReports = function (filenames) {
  var reports = []

  this.eachReport(filenames, report => {
    reports.push(report)
  })

  return reports
}

NYC.prototype.tempDirectory = function () {
  return path.resolve(this.cwd, this._tempDirectory)
}

NYC.prototype.reportDirectory = function () {
  return path.resolve(this.cwd, this._reportDir)
}

NYC.prototype.processInfoDirectory = function () {
  return path.resolve(this.tempDirectory(), 'processinfo')
}

NYC.prototype._reportConfig = function () {
  const config = {}

  this.reporter.forEach(_reporter => {
    config[_reporter] = {
      skipEmpty: this.config.skipEmpty,
      skipFull: this.config.skipFull
    }
  })

  return config
}

NYC.prototype._reportSummarizer = function () {
  return 'pkg'
}

NYC.prototype._reportWatermarks = function () {
  return this.config.watermarks
}

module.exports = NYC
