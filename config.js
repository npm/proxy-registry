'use strict'
const qx = require('@perl/qx')
const url = require('url')

const conf = exports.npm = JSON.parse(qx.sync`npm config ls -l --json`)
exports.pacote = {
  cache: getCacheMode(conf),
  cacheManager: `${conf.cache}/_cacache`,
  ca: conf.ca,
  cert: conf.cert,
  headers: getHeaders('', conf.registry, conf),
  key: conf.key,
  localAddress: conf['local-address'],
  maxSockets: conf['maxsockets'],
  proxy: conf.proxy,
  retry: conf.retry,
  strictSSL: !!conf['strict-ssl'],
  timeout: conf.timeout,
  uid: conf.uid,
  gid: conf.gid
}

function getCacheMode (opts) {
  return opts.offline
    ? 'only-if-cached'
    : opts['prefer-offline']
      ? 'force-cache'
      : opts['prefer-online']
        ? 'no-cache'
        : 'default'
}
function getHeaders (uri, registry, opts) {
  const headers = Object.assign({
    'user-agent': opts['user-agent']
  }, opts.headers)
  // check for auth settings specific to this registry
  let auth = (
    opts.auth &&
    opts.auth[registryKey(registry)]
  ) || opts.auth
  // If a tarball is hosted on a different place than the manifest, only send
  // credentials on `alwaysAuth`
  const shouldAuth = auth && (
    auth.alwaysAuth ||
    url.parse(uri).host === url.parse(registry).host
  )
  if (shouldAuth && auth.token) {
    headers.authorization = `Bearer ${auth.token}`
  } else if (shouldAuth && auth.username && auth.password) {
    const encoded = Buffer.from(
      `${auth.username}:${auth.password}`, 'utf8'
    ).toString('base64')
    headers.authorization = `Basic ${encoded}`
  } else if (shouldAuth && auth._auth) {
    headers.authorization = `Basic ${auth._auth}`
  }
  return headers
}

function registryKey (registry) {
  const parsed = url.parse(registry)
  const formatted = url.format({
    host: parsed.host,
    pathname: parsed.pathname,
    slashes: parsed.slashes
  })
  return url.resolve(formatted, '.')
}
