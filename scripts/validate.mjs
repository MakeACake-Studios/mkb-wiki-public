import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadWikiContent } from './wiki-content-lib.mjs'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const articles = loadWikiContent(rootDir)

console.log(`Validated ${articles.length} wiki articles`)
