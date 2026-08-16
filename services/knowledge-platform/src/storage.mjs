import { Client } from 'minio'
import { config } from './config.mjs'

export const minio = new Client({
  endPoint: config.minioEndpoint,
  port: config.minioPort,
  useSSL: config.minioUseSsl,
  accessKey: config.minioAccessKey,
  secretKey: config.minioSecretKey,
})

export async function putObject(bucket, key, buffer, mediaType) {
  await minio.putObject(bucket, key, buffer, buffer.length, { 'Content-Type': mediaType })
}

export async function readObject(bucket, key) {
  const stream = await minio.getObject(bucket, key)
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return Buffer.concat(chunks)
}

export async function removeObject(bucket, key) {
  await minio.removeObject(bucket, key)
}
