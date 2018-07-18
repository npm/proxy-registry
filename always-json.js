const error = require('koa-json-error')

module.exports = function () {
  const errorHandler = error()

  return async function (ctx, next) {
    await new Promise(next => errorHandler(ctx, next))
    ctx.assert(ctx.request.accepts('json'), 406);
    ctx.response.type = 'json'
    return next()
  }
}  
