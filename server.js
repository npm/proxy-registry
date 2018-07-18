'use strict'
const pacote = require('pacote')
const fetch = require('make-fetch-happen')
const qr = require('@perl/qr')

const Koa = require('koa')
const compress = require('koa-compress')
const logger = require('koa-logger')
const alwaysJson = require('./always-json.js')

const conf = require('./config.js')

const registry = conf.npm.registry.replace(/[/]$/, '')

const matchName = qr`(?:@[^/+]/)?[^/]+`
const matchVersion = qr`\d+\.\d+\.\d+(?:-.*)?`
const matchTarball = qr`^/(${matchName})/-/.*?-(${matchVersion})\.tgz$`
const matchManifest = qr`^/(${matchName})$`

async function handleRequest (ctx, next) {
  const requestConfig = Object.assign({}, conf.pacote, {headers: ctx.request.header})
  delete requestConfig.headers.host
  requestConfig.method = ctx.request.method

  if (matchTarball.test(ctx.request.url)) {
    await fetchTarball(ctx, requestConfig)
  } else if (matchManifest.test(ctx.request.url)) {
    await fetchManifest(ctx, requestConfig)
  } else {
    const result = await proxyRequest(ctx.request.url, ctx, requestConfig)
    ctx.response.body = result.body
  }
  await next()
}

function fetchTarball (ctx, requestConfig) {
  const [, name, version] = matchTarball.exec(ctx.request.url)
  ctx.response.body = pacote.tarball.stream(`${name}@${version}`, requestConfig)
}

async function fetchManifest (ctx, requestConfig) {
  const [, name] = matchManifest.exec(ctx.request.url)
  const result = await proxyRequest(`/${name}`, ctx, requestConfig)
  const body = JSON.parse(await result.buffer())
  for (let version of Object.keys(body.versions)) {
    let vv = body.versions[version]
    vv.dist.tarball = vv.dist.tarball.replace(qr.g`${registry}`, `http://localhost:22000`)
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

const app = new Koa()
app.use(logger())
app.use(alwaysJson())
app.use(compress())
app.use(handleRequest)
console.log('Listening on', 22000)
app.listen(22000)
