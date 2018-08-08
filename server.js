#!/usr/bin/env node
'use strict'
require('@iarna/cli')(main)
  .option('port', {
    describe: 'the port to listen on',
    type: 'number',
    default: 22000
  })
  .option('web-port', {
    describe: 'the port to listen on',
    type: 'number',
    default: 22080
  })
  .option('shell', {
    describe: 'run a shell configured to talk to this proxy',
    type: 'boolean',
    default: true
  })
  .option('log', {
    describe: 'log requests (defaults to off when running a shell, on when not)',
    type: 'boolean'
  })

const fun = require('funstream')
const ssri = require('ssri')
const spawn = require('child_process').spawn
const pacote = require('pacote')
const fetch = require('make-fetch-happen')
const qr = require('@perl/qr')
const http = require('http')
const cache = require('cacache/en')
const Koa = require('koa')
const compress = require('koa-compress')
const logger = require('koa-logger')
const alwaysJson = require('./always-json.js')
const fetchPackument = require('./fetch-packument.js')
const tar = require('tar')
const MarkdownIt = require('markdown-it')
const md = new MarkdownIt()
const conf = require('./config.js')

const registry = conf.npm.registry.replace(/[/]$/, '')

const cacheDir = conf.npm.cache + '/_cacache'

async function main (opts, ...args) {
  if (opts.log == null) opts.log = !opts.shell

  const reg = new Koa()
  if (opts.log) reg.use(logger())
  reg.use(alwaysJson())
  reg.use(compress())
  reg.use(registryRequest)
  const regHttp = http.createServer(reg.callback()).listen(opts.port)

  const web = new Koa()
  if (opts.log) web.use(logger())
  web.use(compress())
  web.use(webRequest)
  const webHttp = http.createServer(web.callback()).listen(opts['web-port'])

  await Promise.race([new Promise((resolve, reject) => {
    reg.on('error', reject)
    regHttp.on('error', reject)
    if (opts.shell) {
      process.env['npm_config_registry'] = `http://127.0.0.1:${opts.port}`
      console.log(`Starting subshell configured to talk to: http://127.0.0.1:${opts.port}`)
      console.log(`Web server: http://127.0.0.1:${opts['web-port']}`)
      console.log(`To close server, run: exit`)
      spawn(conf.npm.shell, [], {stdio: 'inherit'})
        .on('close', er => er ? reject(er) : resolve())
    } else {
      console.log(`Web server: http://127.0.0.1:${opts['web-port']}`)
      console.log(`To use: npm config set registry http://127.0.0.1:${opts.port}`)
      console.log(`^C to close server`)
      process.on('SIGINT', resolve)
    }
  }), new Promise((resolve, reject) => {
    web.on('error', reject)
    webHttp.on('error', reject)
  })])
  console.error('\nShutting down')
  regHttp.close()
  webHttp.close()
}

const matchName = qr`(?:@[^/]+/)?[^/]+`
const matchVersion = qr`\d+\.\d+\.\d+(?:-.*)?`

const matchWebPackage = qr`^/package/(${matchName})(?:/(${matchVersion}))?(?:[?].*)?$`
async function webRequest (ctx, next) {
  try {
    if (ctx.request.url === '/') {
      await webHome(ctx)
    } else if (matchWebPackage.test(ctx.request.url)) {
      const [, name, version] = matchWebPackage.exec(ctx.request.url)
      await webPackage(ctx, name, version)
    } else {
console.error(matchWebPackage, ctx.request.url)
      await webNotFound(ctx)
    }
  } catch (ex) {
    console.error(ex)
    ctx.response.status = 500
    ctx.response.body = `<pre>${JSON.stringify(ex)}</pre>`
  }
  await next()
}

async function webNotFound (ctx) {
  ctx.response.status = 404
  ctx.response.body = '<h1>Not found</h1>'
}

async function tarballMetadata (tarball) {
  const tb = await cache.get(cacheDir, `make-fetch-happen:request-cache:${tarball}`)

  let readmeP
  let pjsonP
  let shrinkP
  await fun(tb).pipe(tar.t()).on('entry', async entry => {
    if (!readmeP && qr.i`^[^/]+/readme(?:$|[.])`.test(entry.path)) readmeP = entry.pipe(fun()).concat()
    if (!pjsonP && qr`^[^/]+/package.json`.test(entry.path)) pjsonP = entry.pipe(fun()).concat()
    if (!shrinkP && qr`^[^/]+/npm-shrinkwrap.json`.test(entry.path)) shrinkP = entry.pipe(fun()).concat()
  })
  const [readme, pjson, shrink] = await Promise.all([readmeP, pjsonP, shrinkP])
  return {readme, manifest: pjson && JSON.parse(pjson), shrinkwrap: shrink && JSON.parse(shrink)}
}

async function webPackage (ctx, name, version) {
  const ent = await cache.get(cacheDir, `make-fetch-happen:request-cache:${registry}/${name.replace('/', '%2f')}`)
  const packument = JSON.parse(ent.data)
  if (!version) {
    version = packument['dist-tags'].latest
  }
  const manifest = packument.versions[version]
  const tarball = manifest.dist.tarball
  const integrity = manifest.dist.integrity || ssri.fromHex(manifest.dist.shasum, 'sha1').toString()
  let readme = ''
  try {
    const pkg = await tarballMetadata(tarball)
    if (pkg.readme) readme = pkg.readme
    if (pkg.manifest) manifest = pkg.manifest
  } catch (_) {
  }
  ctx.response.body = `<html>
<head>
  <style>
   body { margin: 5em; }
    #readme { float: left; width: 75%; }
    .manifest { width: 23%; overflow: none; }
  </style>
</head>
<body>
  <div id="readme">${md.render(readme)}</div>
  <div class="manifest"><pre>${JSON.stringify(manifest, null, 2)}</pre></div>
</body>
</html>
`
  ctx.response.status = 200
}

async function webHome (ctx) {
  ctx.response.body = `<html>
  <body>
    ${await listModules()}
  </body>
</html>`
  ctx.response.status = 200

}

const matchCacheTarball = qr`^make-fetch-happen:request-cache:(https?://[^/]+/(${matchName})/-/.*?-(${matchVersion})[.]tgz)$`

const matchCachePackument = qr`^make-fetch-happen:request-cache:https?://[^/]+/(${matchName})$`
async function listModules() {
  const modules = {}
  Object.values(await cache.ls(cacheDir)).forEach(_ => {
    if (matchCacheTarball.test(_.key)) {
      const [, tarball, name, version] = matchCacheTarball.exec(_.key)
      if (!modules[name]) modules[name] = {name, versions: {}}
      if (!modules[name].tarball) modules[name].tarball = tarball
      modules[name].versions[version] = {name, version, tarball}
    } else if (matchCachePackument.test(_.key)) {
      const [, name] = matchCachePackument.exec(_.key)
      if (!modules[name]) modules[name] = {name, versions: {}}
      modules[name].packument = true
    }
  })
  const listing = Object.values(modules).filter(_ => _.tarball && _.packument).sort((aa, bb) => aa.name.localeCompare(bb.name))
  return fun(listing).map(async _ => {
    try {
      const pkg = await tarballMetadata(_.tarball)
      return `<b><a href="/package/${_.name}">${_.name}</a></b> (` +
        Object.values(_.versions).map(_ => `<a href="/package/${_.name}/${_.version}">${_.version}</a>`).join(', ') +
        `)${pkg.manifest.description ? ': ' + pkg.manifest.description : ''}`
    } catch (_) {
      console.log(_)
    }
  }).filter(_ => _).grab(_ => _.join('<br>\n'))
}

const matchTarball = qr`^/(${matchName})/-/.*?-(${matchVersion})\.tgz$`
const matchManifest = qr`^/(${matchName})$`

async function registryRequest (ctx, next) {
  const requestConfig = Object.assign({}, conf.pacote, {headers: ctx.request.header})
  delete requestConfig.headers.host
  requestConfig.method = ctx.request.method

  try {
    if (matchTarball.test(ctx.request.url)) {
      await fetchTarball(ctx, requestConfig)
    } else if (matchManifest.test(ctx.request.url)) {
      await fetchManifest(ctx, requestConfig)
    } else {
      const result = await proxyRequest(ctx.request.url, ctx, requestConfig)
      ctx.response.body = result.body
    }
  } catch (ex) {
    console.error(ex)
    ctx.response.status = 500
    ctx.response.body = JSON.stringify(ex)
  }
  await next()
}

function fetchTarball (ctx, requestConfig) {
  const [, name, version] = matchTarball.exec(ctx.request.url)
  ctx.response.body = pacote.tarball.stream(`${name}@${version}`, requestConfig)
}

async function fetchManifest (ctx, requestConfig) {
  const [, name] = matchManifest.exec(ctx.request.url)
  const body = await fetchPackument(name, requestConfig)
  for (let version of Object.keys(body.versions)) {
    let vv = body.versions[version]
    vv.dist.tarball = vv.dist.tarball.replace(qr.g`${registry}`, `http://127.0.0.1:22000`)
  }
  ctx.response.body = JSON.stringify(body)
}

async function proxyRequest (url, ctx, requestConfig) {
  if (requestConfig.method === 'PUT' || requestConfig.method === 'POST') requestConfig.body = ctx.req

  const result = await fetch(`${registry}${url}`, requestConfig)
  for (let header of result.headers.entries()) {
    const [key, value] = header
    if (key === 'transfer-encoding' || key === 'content-encoding' || key === 'content-length' || key === 'connection') continue
    ctx.response.set(key, value)
  }
  ctx.response.status = result.status
  return result
}
