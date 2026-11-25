import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { loadWikiContent } from '../scripts/wiki-content-lib.mjs'

const marker = (type = 'screenshot') =>
  `<!-- WIKI-IMAGE\nID: IMG-private-brief\nTYPE: ${type}\nDESCRIPTION: Invisible description token\nPURPOSE: Invisible purpose token\n-->`

test('links allow the standalone nether-roads route but still reject unknown slugs', () => {
  withArticle((load) => {
    const article = load('[Nether roads](/wiki/nether-roads)')
    assert.equal(article.slug, 'example')
    assert.deepEqual(article.blocks, [{
      type: 'paragraph',
      children: [{ type: 'link', slug: 'nether-roads', children: ['Nether roads'] }],
    }])
    for (const slug of ['unknown-route', 'nether-roads-extra', 'nether-roads/unknown']) {
      assert.throws(
        () => load(`[Unknown](/wiki/${slug})`),
        new RegExp(`Broken internal wiki links:[\\s\\S]*example -> ${slug}`),
      )
    }
  })
})

function withArticle(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mkb-wiki-image-comments-'))
  const articlePath = path.join(directory, 'articles', 'example.md')
  fs.mkdirSync(path.dirname(articlePath))
  const load = (body) => {
    fs.writeFileSync(articlePath, `---\ntitle: Example\n---\n\n${body}\n`)
    return loadWikiContent(directory)[0]
  }
  try {
    run(load)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

test('hidden frontmatter excludes source-only pages and rejects public links to them', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mkb-wiki-hidden-'))
  const articles = path.join(directory, 'articles')
  fs.mkdirSync(articles)
  const write = (name, frontmatter, body) =>
    fs.writeFileSync(path.join(articles, `${name}.md`), `---\ntitle: ${name}\n${frontmatter}---\n\n${body}\n`)
  try {
    write('visible', 'hidden: false\n', 'Public article.')
    write('private', 'hidden: true\n', 'PRIVATE-SEASON-TOKEN\n\n[Hidden source link](/absent)')
    const result = loadWikiContent(directory)
    assert.deepEqual(result.map((article) => article.slug), ['visible'])
    assert.equal(JSON.stringify(result).includes('PRIVATE-SEASON-TOKEN'), false)
    write('visible', '', '[Private page](/private)')
    assert.throws(() => loadWikiContent(directory), /Broken internal wiki links:[\s\S]*visible -> private/)
    write('visible', '', 'Public article.')
    write('private', 'hidden: "true"\n', 'Private article.')
    assert.throws(() => loadWikiContent(directory), /frontmatter hidden must be a boolean/)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('all image brief types disappear from blocks and serialized public/search input', () => {
  withArticle((load) => {
    const expectedBlocks = load('Before.\n\nAfter.').blocks
    for (const type of ['screenshot', 'gui', 'item', 'recipe', 'comparison', 'diagram', 'sequence', 'gif']) {
      for (const newline of ['\n', '\r\n']) {
        const article = load(`Before.\n\n${marker(type).replaceAll('\n', newline)}\n\nAfter.`)
        assert.deepEqual(article.blocks, expectedBlocks)
        // Sync serializes these articles verbatim; search indexes their blocks.
        const payload = JSON.stringify(article)
        for (const privateText of ['WIKI-IMAGE', 'IMG-private-brief', 'Invisible description token', 'Invisible purpose token']) {
          assert.equal(payload.includes(privateText), false)
        }
      }
    }
  })
})

test('ordinary standalone comments hide singleline and multiline draft content', () => {
  withArticle((load) => {
    const expectedBlocks = load('Before.\n\nAfter.').blocks
    const comments = [
      '<!-- private singleline draft -->',
      '<!--\n# Hidden clans draft\n\nUnpublished clan instructions.\n\n## Cave history\nHistorical cave details.\n<div>Hidden HTML inside comment</div>\n-->',
      `${marker()}\n<!-- private singleline draft -->`,
    ]
    for (const comment of comments) {
      for (const newline of ['\n', '\r\n']) {
        const article = load(`Before.\n\n${comment.replaceAll('\n', newline)}\n\nAfter.`)
        assert.deepEqual(article.blocks, expectedBlocks)
        const payload = JSON.stringify(article)
        for (const privateText of ['WIKI-IMAGE', 'IMG-private-brief', 'Invisible description token', 'Invisible purpose token', 'private singleline draft', 'Hidden clans draft', 'Unpublished clan instructions', 'Cave history', 'Historical cave details', 'Hidden HTML inside comment', '<!--', '-->']) {
          assert.equal(payload.includes(privateText), false)
        }
      }
    }
  })
})

test('raw HTML, nonstandalone or malformed comments, and malformed image markers remain forbidden', () => {
  withArticle((load) => {
    const valid = marker()
    const invalid = [
      '<div>Raw HTML</div>',
      '<script>alert(1)</script>',
      '<!-- WIKI-IMAGE -->',
      '<!-- WIKI-IMAGE-invalid -->',
      '<!-- unclosed ordinary comment',
      '<!-- outer <!-- nested --> -->',
      '<!-- invalid --!> -->',
      '<!--> invalid -->',
      '<!---> invalid -->',
      '<!-- invalid <!--->',
      '<!-- ordinary comment --><div>Raw HTML</div>',
      '<!-- ordinary comment -->\n<div>Raw HTML</div>',
      'Text <!-- ordinary comment -->',
      '<!-- ordinary comment --> trailing text',
      valid.replace('IMG-private-brief', 'private-brief'),
      valid.replace('IMG-private-brief', 'IMG-'),
      valid.replace('screenshot', 'video'),
      valid.replace('ID: IMG-private-brief\n', ''),
      valid.replace('TYPE: screenshot\n', ''),
      valid.replace('DESCRIPTION: Invisible description token\n', ''),
      valid.replace('PURPOSE: Invisible purpose token\n', ''),
      valid.replace('Invisible description token', '   '),
      valid.replace('Invisible purpose token', ''),
      valid.replace('\n-->', '\nEXTRA: hidden\n-->'),
      valid.replace('\n-->', ''),
      valid.replace('Invisible description token', '<!-- nested -->'),
      `${valid}<div>Raw HTML</div>`,
      `${valid}\n<div>Raw HTML</div>`,
      `Text ${valid}`,
      `${valid} trailing text`,
    ]
    for (const body of invalid) {
      assert.throws(() => load(body), /raw HTML is not allowed|unsupported inline Markdown node: html/, body)
    }
  })
})
