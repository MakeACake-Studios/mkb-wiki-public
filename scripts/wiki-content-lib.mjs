import fs from 'node:fs'
import path from 'node:path'
import remarkDirective from 'remark-directive'
import remarkFrontmatter from 'remark-frontmatter'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import YAML from 'yaml'

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'])
const SAFE_REMOTE_PROTOCOLS = new Set(['http:', 'https:'])

function fail(filePath, node, message) {
  const line = node?.position?.start?.line
  throw new Error(`${filePath}${line ? `:${line}` : ''}: ${message}`)
}

function textContent(node) {
  if (typeof node.value === 'string') return node.value
  return (node.children ?? []).map(textContent).join('')
}

function parseOptionalNumber(value, filePath, node, field) {
  if (value === undefined) return undefined

  const number = Number(value)

  if (!Number.isFinite(number) || number <= 0) {
    fail(filePath, node, `${field} must be a positive number`)
  }

  return number
}

function parseOptionalImageWidth(value, filePath, node) {
  if (value === undefined) return undefined

  const normalized = String(value).trim()
  const match = normalized.match(/^(\d+(?:\.\d+)?)%$/)

  if (!match) {
    fail(
        filePath,
        node,
        'image width must be a percentage, for example: 50%',
    )
  }

  const number = Number(match[1])

  if (!Number.isFinite(number) || number <= 0 || number > 100) {
    fail(
        filePath,
        node,
        'image width must be greater than 0% and no greater than 100%',
    )
  }

  return `${number}%`
}

function normalizeSlugFromFile(articlesDir, filePath) {
  const relative = path.relative(articlesDir, filePath).replaceAll(path.sep, '/')
  const withoutExtension = relative.replace(/\.md$/i, '')

  return withoutExtension.endsWith('/index')
      ? withoutExtension.slice(0, -'/index'.length)
      : withoutExtension
}

function resolveContentUrl(url, context, node) {
  if (!url) {
    fail(context.filePath, node, 'empty URL')
  }

  if (/^[a-z][a-z\d+.-]*:/i.test(url)) {
    let parsed

    try {
      parsed = new URL(url)
    } catch {
      fail(context.filePath, node, `invalid URL: ${url}`)
    }

    if (!SAFE_REMOTE_PROTOCOLS.has(parsed.protocol)) {
      fail(
          context.filePath,
          node,
          `unsupported URL protocol: ${parsed.protocol}`,
      )
    }

    return url
  }

  if (url.startsWith('/')) {
    return url
  }

  const [pathname, suffix = ''] = url.split(/(?=[?#])/u, 2)
  const absolutePath = path.resolve(path.dirname(context.filePath), pathname)
  const relativePath = path.relative(context.contentDir, absolutePath)

  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    fail(
        context.filePath,
        node,
        `path leaves the content repository: ${url}`,
    )
  }

  if (!fs.existsSync(absolutePath)) {
    fail(
        context.filePath,
        node,
        `referenced file does not exist: ${url}`,
    )
  }

  return `/wiki-content/${relativePath.replaceAll(path.sep, '/')}${suffix}`
}

function internalSlug(url) {
  const clean = url
      .replace(/^\/wiki\//, '/')
      .replace(/^\//, '')
      .replace(/\/$/, '')

  return clean || undefined
}

function inlineNodes(nodes, context) {
  return nodes.flatMap((node) => {
    switch (node.type) {
      case 'text':
        return [node.value]

      case 'strong':
        return [
          {
            type: 'strong',
            children: inlineNodes(node.children, context),
          },
        ]

      case 'emphasis':
        return [
          {
            type: 'em',
            children: inlineNodes(node.children, context),
          },
        ]

      case 'delete':
        return [
          {
            type: 'strike',
            children: inlineNodes(node.children, context),
          },
        ]

      case 'inlineCode':
        return [
          {
            type: 'code',
            text: node.value,
          },
        ]

      case 'break':
        return ['\n']

      case 'link': {
        const children = inlineNodes(node.children, context)

        if (node.url.startsWith('/') && !node.url.startsWith('//')) {
          return [
            {
              type: 'link',
              children,
              slug: internalSlug(node.url),
            },
          ]
        }

        return [
          {
            type: 'link',
            children,
            href: resolveContentUrl(node.url, context, node),
          },
        ]
      }

      case 'textDirective': {
        if (node.name !== 'underline' && node.name !== 'spoiler') {
          fail(
              context.filePath,
              node,
              `unsupported inline directive: ${node.name}`,
          )
        }

        return [
          {
            type: node.name,
            children: inlineNodes(node.children, context),
          },
        ]
      }

      default:
        fail(
            context.filePath,
            node,
            `unsupported inline Markdown node: ${node.type}`,
        )
    }
  })
}

function parseHeadingDirective(node, context) {
  const attributes = node.attributes ?? {}
  const level = Number(attributes.level ?? 2)

  if (![1, 2, 3].includes(level)) {
    fail(
        context.filePath,
        node,
        'heading directive level must be 1, 2 or 3',
    )
  }

  const heading = {
    type: 'heading',
    level,
    text: textContent(node).trim(),
  }

  if (attributes.icon) {
    heading.icon = {
      src: resolveContentUrl(attributes.icon, context, node),
      ...(attributes.iconAlt
          ? {
            alt: attributes.iconAlt,
          }
          : {}),
      ...(attributes.iconWidth
          ? {
            width: parseOptionalNumber(
                attributes.iconWidth,
                context.filePath,
                node,
                'iconWidth',
            ),
          }
          : {}),
    }
  }

  if (attributes.gradientFrom || attributes.gradientTo) {
    if (!attributes.gradientFrom || !attributes.gradientTo) {
      fail(
          context.filePath,
          node,
          'both gradientFrom and gradientTo are required',
      )
    }

    heading.gradient = [
      attributes.gradientFrom,
      attributes.gradientTo,
    ]
  }

  return heading
}

function markdownImageBlock(node, context, width) {
  return {
    type: 'image',
    src: resolveContentUrl(node.url, context, node),
    ...(node.alt ? { alt: node.alt } : {}),
    ...(width !== undefined ? { width } : {}),
  }
}

function parseMarkdownImageWidthSuffix(value, context, node) {
  const normalized = value.trim()

  if (!normalized) {
    return undefined
  }

  const match = normalized.match(
      /^\{\s*width\s*=\s*(\d+(?:\.\d+)?)%\s*\}$/,
  )

  if (!match) {
    fail(
        context.filePath,
        node,
        'invalid image attributes; expected {width=50%}',
    )
  }

  return parseOptionalImageWidth(
      `${match[1]}%`,
      context.filePath,
      node,
  )
}

function markdownImageParagraph(node, context) {
  if (node.type !== 'paragraph') {
    return undefined
  }

  if (!node.children?.length) {
    return undefined
  }

  const image = node.children[0]

  if (image.type !== 'image') {
    return undefined
  }

  const imageEnd = image.position?.end?.offset
  const paragraphEnd = node.position?.end?.offset

  if (
      typeof imageEnd !== 'number' ||
      typeof paragraphEnd !== 'number'
  ) {
    if (node.children.length === 1) {
      return markdownImageBlock(image, context)
    }

    fail(
        context.filePath,
        node,
        'could not determine image attribute position',
    )
  }

  const suffix = context.source
      .slice(imageEnd, paragraphEnd)
      .trim()

  // Обычная картинка без width:
  //
  // ![Картинка](image.webp)
  if (!suffix) {
    return markdownImageBlock(
        image,
        context,
    )
  }

  // Картинка с шириной:
  //
  // ![Картинка](image.webp){width=50%}
  const match = suffix.match(
      /^\{\s*width\s*=\s*(\d+(?:\.\d+)?)%\s*\}$/,
  )

  if (!match) {
    fail(
        context.filePath,
        node,
        'invalid image attributes; expected {width=50%}',
    )
  }

  const width = parseOptionalImageWidth(
      `${match[1]}%`,
      context.filePath,
      node,
  )

  return markdownImageBlock(
      image,
      context,
      width,
  )
}

function imageDirectiveBlock(node, context) {
  const attributes = node.attributes ?? {}

  if (!attributes.src) {
    fail(
        context.filePath,
        node,
        'image directive requires src',
    )
  }

  return {
    type: 'image',
    src: resolveContentUrl(
        attributes.src,
        context,
        node,
    ),
    ...(attributes.alt
        ? {
          alt: attributes.alt,
        }
        : {}),
    ...(attributes.width !== undefined
        ? {
          width: parseOptionalImageWidth(
              attributes.width,
              context.filePath,
              node,
          ),
        }
        : {}),
  }
}

function galleryImages(node, context) {
  const images = []

  for (const child of node.children) {
    if (
        child.type === 'leafDirective' &&
        child.name === 'image'
    ) {
      images.push(
          imageDirectiveBlock(child, context),
      )

      continue
    }

    if (child.type === 'paragraph') {
      let index = 0

      while (index < child.children.length) {
        const inline = child.children[index]

        if (inline.type === 'image') {
          let width
          const next = child.children[index + 1]

          if (next?.type === 'text') {
            const parsedWidth =
                parseMarkdownImageWidthSuffix(
                    next.value,
                    context,
                    next,
                )

            if (parsedWidth !== null) {
              width = parsedWidth
              index++
            }
          }

          images.push(
              markdownImageBlock(
                  inline,
                  context,
                  width,
              ),
          )

          index++
          continue
        }

        if (
            inline.type === 'text' &&
            !inline.value.trim()
        ) {
          index++
          continue
        }

        fail(
            context.filePath,
            inline,
            'gallery directive may only contain images',
        )
      }

      continue
    }

    fail(
        context.filePath,
        child,
        'gallery directive may only contain images',
    )
  }

  if (images.length < 2) {
    fail(
        context.filePath,
        node,
        'gallery directive must contain at least two images',
    )
  }

  return images
}

function blockNodes(nodes, context) {
  const blocks = []

  for (const node of nodes) {
    switch (node.type) {
      case 'yaml':
        break

        /*
         * Markdown comments in the form:
         *
         * [//]&#58; # (comment)
         *
         * are parsed by remark as definitions.
         *
         * We do not render them.
         */
      case 'definition':
        break

      case 'heading':
        blocks.push({
          type: 'heading',
          level: node.depth,
          text: textContent(node).trim(),
        })
        break

      case 'paragraph': {
        const image = markdownImageParagraph(
            node,
            context,
        )

        if (image) {
          blocks.push(image)
        } else {
          blocks.push({
            type: 'paragraph',
            children: inlineNodes(
                node.children,
                context,
            ),
          })
        }

        break
      }

      case 'list': {
        const items = node.children.map((item) => {
          if (
              item.children.length !== 1 ||
              item.children[0].type !== 'paragraph'
          ) {
            fail(
                context.filePath,
                item,
                'list items must contain one paragraph',
            )
          }

          return inlineNodes(
              item.children[0].children,
              context,
          )
        })

        blocks.push({
          type: 'list',
          ordered: Boolean(node.ordered),
          items,
        })

        break
      }

      case 'blockquote':
        blocks.push({
          type: 'quote',
          blocks: blockNodes(
              node.children,
              context,
          ),
        })
        break

      case 'thematicBreak':
        blocks.push({
          type: 'hr',
        })
        break

      case 'table': {
        const rows = node.children.map((row) =>
            row.children.map((cell) =>
                inlineNodes(
                    cell.children,
                    context,
                ),
            ),
        )

        const headers = rows.shift() ?? []

        blocks.push({
          type: 'table',
          headers,
          rows,
          ...(node.align?.some(Boolean)
              ? {
                align: node.align.map(
                    (alignment) =>
                        alignment ?? 'left',
                ),
              }
              : {}),
        })

        break
      }

      case 'code':
        blocks.push({
          type: 'code',
          code: node.value,
          ...(node.lang
              ? {
                language: node.lang,
              }
              : {}),
        })
        break

      case 'containerDirective': {
        if (node.name === 'gallery') {
          const images = galleryImages(
              node,
              context,
          )

          const columns =
              node.attributes?.columns === undefined
                  ? undefined
                  : Number(
                      node.attributes.columns,
                  )

          if (
              columns !== undefined &&
              ![2, 3, 4].includes(columns)
          ) {
            fail(
                context.filePath,
                node,
                'gallery columns must be 2, 3 or 4',
            )
          }

          blocks.push({
            type: 'image-group',
            images,
            ...(columns
                ? {
                  columns,
                }
                : {}),
          })

          break
        }

        if (
            node.name !== 'tip' &&
            node.name !== 'info'
        ) {
          fail(
              context.filePath,
              node,
              `unsupported block directive: ${node.name}`,
          )
        }

        const title =
            node.attributes?.title

        if (!title) {
          fail(
              context.filePath,
              node,
              `${node.name} directive requires a title`,
          )
        }

        blocks.push({
          type: 'callout',
          variant: node.name,
          title,
          blocks: blockNodes(
              node.children,
              context,
          ),
        })

        break
      }

      case 'leafDirective': {
        const attributes =
            node.attributes ?? {}

        if (node.name === 'youtube') {
          if (!attributes.id) {
            fail(
                context.filePath,
                node,
                'youtube directive requires id',
            )
          }

          blocks.push({
            type: 'youtube',
            id: attributes.id,
          })
        } else if (
            node.name === 'image'
        ) {
          blocks.push(
              imageDirectiveBlock(
                  node,
                  context,
              ),
          )
        } else if (
            node.name === 'heading'
        ) {
          blocks.push(
              parseHeadingDirective(
                  node,
                  context,
              ),
          )
        } else {
          fail(
              context.filePath,
              node,
              `unsupported leaf directive: ${node.name}`,
          )
        }

        break
      }

      case 'html':
        fail(
            context.filePath,
            node,
            'raw HTML is not allowed',
        )
        break

      default:
        fail(
            context.filePath,
            node,
            `unsupported Markdown node: ${node.type}`,
        )
    }
  }

  return blocks
}

function markdownFiles(directory) {
  return fs
      .readdirSync(
          directory,
          {
            withFileTypes: true,
          },
      )
      .flatMap((entry) => {
        const entryPath = path.join(
            directory,
            entry.name,
        )

        if (entry.isDirectory()) {
          return markdownFiles(entryPath)
        }

        return entry.isFile() &&
        entry.name.endsWith('.md')
            ? [entryPath]
            : []
      })
}

export function loadWikiContent(contentDir) {
  const resolvedContentDir =
      path.resolve(contentDir)

  const articlesDir = path.join(
      resolvedContentDir,
      'articles',
  )

  if (!fs.existsSync(articlesDir)) {
    throw new Error(
        `Wiki articles directory does not exist: ${articlesDir}`,
    )
  }

  const processor = unified()
      .use(remarkParse)
      .use(
          remarkFrontmatter,
          ['yaml'],
      )
      .use(remarkGfm)
      .use(remarkDirective)

  const articles =
      markdownFiles(articlesDir).map(
          (filePath) => {
            const source = fs.readFileSync(
                filePath,
                'utf8',
            )

            const tree = processor.parse(source)

            const frontmatterNode = tree.children.find(
                (node) => node.type === 'yaml',
            )

            if (!frontmatterNode) {
              fail(
                  filePath,
                  tree,
                  'YAML frontmatter is required',
              )
            }

            const metadata =
                YAML.parse(frontmatterNode.value) ?? {}

            const slug = normalizeSlugFromFile(
                articlesDir,
                filePath,
            )

            if (!slug) {
              fail(
                  filePath,
                  frontmatterNode,
                  'the root index.md is not a valid article',
              )
            }

            if (
                typeof metadata.title !== 'string' ||
                !metadata.title.trim()
            ) {
              fail(
                  filePath,
                  frontmatterNode,
                  'frontmatter title is required',
              )
            }

            const context = {
              contentDir: resolvedContentDir,
              filePath,
              source,
            }

            const article = {
              slug,
              title: metadata.title.trim(),
              order: Number.isFinite(
                  Number(metadata.order),
              )
                  ? Number(metadata.order)
                  : 999,
              blocks: blockNodes(
                  tree.children,
                  context,
              ),
            }

            return article
          },
      )

  const seenSlugs = new Set()

  for (const article of articles) {
    if (
        seenSlugs.has(article.slug)
    ) {
      throw new Error(
          `Duplicate wiki slug: ${article.slug}`,
      )
    }

    seenSlugs.add(article.slug)
  }

  const brokenLinks = []

  const visitInline = (
      nodes,
      article,
  ) => {
    for (const node of nodes) {
      if (typeof node === 'string') {
        continue
      }

      if (
          node.type === 'link' &&
          node.slug &&
          !seenSlugs.has(node.slug)
      ) {
        brokenLinks.push(
            `${article.slug} -> ${node.slug}`,
        )
      }

      if ('children' in node) {
        visitInline(
            node.children,
            article,
        )
      }
    }
  }

  const visitBlocks = (
      blocks,
      article,
  ) => {
    for (const block of blocks) {
      if (
          block.type === 'paragraph'
      ) {
        visitInline(
            block.children,
            article,
        )
      }

      if (block.type === 'list') {
        block.items.forEach(
            (item) =>
                visitInline(
                    item,
                    article,
                ),
        )
      }

      if (block.type === 'table') {
        block.headers.forEach(
            (cell) =>
                visitInline(
                    cell,
                    article,
                ),
        )

        block.rows
            .flat()
            .forEach((cell) =>
                visitInline(
                    cell,
                    article,
                ),
            )
      }

      if (
          block.type === 'quote' ||
          block.type === 'callout'
      ) {
        visitBlocks(
            block.blocks,
            article,
        )
      }
    }
  }

  articles.forEach((article) =>
      visitBlocks(
          article.blocks,
          article,
      ),
  )

  if (brokenLinks.length) {
    throw new Error(
        `Broken internal wiki links:\n${brokenLinks.join('\n')}`,
    )
  }

  return articles.sort(
      (a, b) =>
          a.order - b.order ||
          a.slug.localeCompare(
              b.slug,
              'ru',
          ),
  )
}