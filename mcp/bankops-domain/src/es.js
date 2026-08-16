const endpoint = (process.env.ELASTICSEARCH_URL ?? 'http://elasticsearch:9200').replace(/\/$/, '')

export async function esSearch(index, body) {
  const response = await fetch(`${endpoint}/${index}/_search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) {
    throw new Error(`Elasticsearch ${response.status}: ${await response.text()}`)
  }
  return response.json()
}

export async function esGet(index, id) {
  const response = await fetch(`${endpoint}/${index}/_doc/${encodeURIComponent(id)}`, {
    signal: AbortSignal.timeout(10_000),
  })
  if (response.status === 404) return null
  if (!response.ok) {
    throw new Error(`Elasticsearch ${response.status}: ${await response.text()}`)
  }
  return (await response.json())._source
}

export function sources(result) {
  return result.hits.hits.map(hit => ({ ...hit._source, _score: hit._score }))
}

export function jsonResult(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  }
}

export function errorResult(error) {
  const message = error instanceof Error ? error.message : String(error)
  return { isError: true, content: [{ type: 'text', text: `BankOps data query failed: ${message}` }] }
}

export function timeRange(startTime, endTime) {
  const range = {}
  if (startTime) range.gte = startTime
  if (endTime) range.lte = endTime
  return Object.keys(range).length ? [{ range: { '@timestamp': range } }] : []
}
