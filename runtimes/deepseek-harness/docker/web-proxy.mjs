import net from 'node:net'

const listenHost = '0.0.0.0'
const listenPort = 3080
const targetHost = '127.0.0.1'
const targetPort = 3081

const server = net.createServer(client => {
  const upstream = net.createConnection({ host: targetHost, port: targetPort })
  client.pipe(upstream)
  upstream.pipe(client)

  const close = () => {
    client.destroy()
    upstream.destroy()
  }
  client.on('error', close)
  upstream.on('error', close)
})

server.listen(listenPort, listenHost, () => {
  console.log(`[bankops-web-proxy] ${listenHost}:${listenPort} -> ${targetHost}:${targetPort}`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
