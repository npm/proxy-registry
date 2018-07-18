const error = require('koa-json-error')

module.exports = function () {
  const errorHandler = error()

  return async function (ctx, next) {
    await new Promise(resolve => errorHandler(ctx, resolve))
    ctx.assert(ctx.request.accepts('json'), 406)
    ctx.response.type = 'json'
    await next()
  }
}
