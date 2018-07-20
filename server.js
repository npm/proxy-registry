#!/usr/bin/env node
'use strict'
require('@iarna/cli')(main)
  .option('port', {
    describe: 'the port to listen on',
    type: 'number',
    default: 22000
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

const spawn = require('child_process').spawn
const pacote = require('pacote')
const fetch = require('make-fetch-happen')
const qr = require('@perl/qr')
const http = require('http');

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

const isWindows = process.platform === 'win32'
const isWindowsBash = (/^MINGW(32|64)$/.test(process.env.MSYSTEM) || process.env.TERM === 'cygwin')
const isWindowsShell = isWindows && !isWindowsBash

async function main (opts, ...args) {
  if (opts.log == null) opts.log = !opts.shell
  const app = new Koa()
  if (opts.log) app.use(logger())
  app.use(alwaysJson())
  app.use(compress())
  app.use(handleRequest)
  const srv = http.createServer(app.callback()).listen(opts.port);

  await new Promise((resolve, reject) => {
    app.on('error', reject)
    srv.on('error', reject)
    if (opts.shell) {
      process.env['npm_config_registry'] = `http://localhost:${opts.port}`
      console.log(`Starting subshell configured to talk to: https://localhost:${opts.port}`)
      console.log(`To close server, run: exit`)
      spawn(conf.npm.shell, [], {stdio: 'inherit'})
        .on('close', er => er ? reject(er) : resolve())
    } else {
      console.log(`Listening on: https://localhost:${opts.port}`)
      console.log(`To use: npm config set registry https://localhost:${opts.port}`)
      console.log(`^C to close server`)
      process.on('SIGINT', resolve)
    }
  })
  console.error('\nShutting down')
  srv.close()
}

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

