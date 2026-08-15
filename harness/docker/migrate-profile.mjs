import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const dshHome = process.argv[2]
if (!dshHome) throw new Error('usage: migrate-profile.mjs <DSH_HOME>')

const common = [
  ['@bankops/dsh-core', 'link:/opt/bankops/plugins/bankops-core'],
  ['@bankops/dsh-change-impact', 'link:/opt/bankops/plugins/bankops-change-impact'],
]

const profilePlugins = {
  web: [
    ...common,
    ['@omdsh-dev/dsh-genui', 'link:/opt/bankops/plugins/external/dsh-genui'],
    ['@dsh-community/dsh-deeplink', 'link:/opt/bankops/plugins/external/dsh-deeplink'],
  ],
  headless: [...common],
  dev: [
    ...common,
    ['dsh-context-doctor', 'link:/opt/bankops/plugins/external/dsh-context-doctor'],
    ['@deepseek-ai/dsh-plugin-check', 'link:/opt/bankops/plugins/external/dsh-plugin-check'],
    ['@deepseek-ai/dsh-security-audit', 'link:/opt/bankops/plugins/external/dsh-security-audit'],
  ],
}

const managedBundles = new Set([
  ...Object.values(profilePlugins).flat().map(([name]) => name),
  'dsh-eval-harness',
])

for (const [profile, plugins] of Object.entries(profilePlugins)) {
  const manifestPath = join(dshHome, 'profiles', profile, 'package.json')
  let manifest
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') continue
    throw error
  }

  manifest.dependencies ??= {}
  for (const name of managedBundles) delete manifest.dependencies[name]
  for (const [name, source] of plugins) manifest.dependencies[name] = source

  const bundles = manifest.dsh?.profile?.bundles
  if (!Array.isArray(bundles)) throw new Error(`${manifestPath}: missing dsh.profile.bundles`)

  manifest.dsh.profile.bundles = [
    ...bundles.filter(bundle => !managedBundles.has(bundle)),
    ...plugins.map(([name]) => name),
  ]

  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}
