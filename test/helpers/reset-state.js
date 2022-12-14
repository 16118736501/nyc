// reset global state modified by nyc in non-integration tests.
const extensions = Object.assign({}, require.extensions) // eslint-disable-line
const glob = require('glob')
const rimraf = require('rimraf')

module.exports = function () {
  // nuke any temporary files created during test runs.
  glob.sync('test/**/*/{.nyc_output,.cache}').forEach(function (path) {
    rimraf.sync(path)
  })
  // reset Node's require cache.
  Object.keys(require.cache).forEach(key => {
    if (key.indexOf('node_modules') === -1) delete require.cache[key]
  })
  // reset any custom loaders for extensions, disabling the stack maintained
  // by append-transform.
  // eslint-disable-next-line
  Object.keys(require.extensions).forEach(key => {
    delete require.extensions[key] // eslint-disable-line
    if (extensions[key]) require.extensions[key] = extensions[key] // eslint-disable-line
  })
  // reset any NYC-specific environment variables that might have been set.
  delete process.env.NYC_CWD
}
