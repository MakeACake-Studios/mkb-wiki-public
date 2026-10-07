import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
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

/**
 * Parses image width.
 *
 * Supported formats:
 *
 * 400  -> number 400 -> rendered as 400px
 * 50%  -> string "50%" -> rendered as 50%
 */
function parseImageWidth(value, filePath, node) {
  if (value === undefined) return undefined

  const normalized = String(value).trim()

  const match = normalized.match(
      /^(\d+(?:\.\d+)?)(%)?$/,
  )

  if (!match) {
    fail(
        filePath,
        node,
        'image width must be a positive number or percentage, for example: 400 or 50%',
    )
  }

  const width = Number(match[1])
  const isPercentage = match[2] === '%'

  if (!Number.isFinite(width) || width <= 0) {
    fail(
        filePath,
        node,
        'image width must be greater than 0',
    )
  }

  if (isPercentage && width > 100) {
    fail(
        filePath,
        node,
        'image width percentage must be no greater than 100%',
    )
  }

  return isPercentage
      ? `${width}%`
      : width
}

/**
 * Parses an attribute suffix after a regular Markdown image.
 *
 * Supported:
 *
 * ![Image](image.png){width=400}
 * ![Image](image.png){width=50%}
 */
function parseImageWidthSuffix(value, filePath, node) {
  const normalized = value.trim()

  const match = normalized.match(
      /^\{\s*width\s*=\s*(\d+(?:\.\d+)?%?)\s*\}$/,
  )

  if (!match) {
    fail(
        filePath,
        node,
        'invalid image attributes; expected {width=400} or {width=50%}',
    )
  }

  return parseImageWidth(
      match[1],
      filePath,
      node,
  )
}

function normalizeSlugFromFile(articlesDir, filePath) {
  const relative = path
      .relative(articlesDir, filePath)
      .replaceAll(path.sep, '/')

  const withoutExtension = relative.replace(
      /\.md$/i,
      '',
  )

  return withoutExtension.endsWith('/index')
      ? withoutExtension.slice(
          0,
          -'/index'.length,
      )
      : withoutExtension
}

function githubUsername(authorName, authorEmail) {
  const noReplyMatch = authorEmail.match(
      /^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/i,
  )

  if (noReplyMatch) {
    return noReplyMatch[1]
  }

  const trimmedName = authorName.trim()

  return /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(
      trimmedName,
  )
      ? trimmedName
      : undefined
}

function lastModification(contentDir, filePath) {
  try {
    const output = execFileSync(
        'git',
        [
          'log',
          '-1',
          '--format=%cI%x00%an%x00%ae',
          '--',
          path.relative(
              contentDir,
              filePath,
          ),
        ],
        {
          cwd: contentDir,
          encoding: 'utf8',
          stdio: [
            'ignore',
            'pipe',
            'ignore',
          ],
        },
    ).trim()

    const [
      modifiedAt,
      authorName = '',
      authorEmail = '',
    ] = output.split('\0')

    if (modifiedAt) {
      const modifiedBy = githubUsername(
          authorName,
          authorEmail,
      )

      return {
        modifiedAt,
        ...(modifiedBy
            ? {
              modifiedBy,
            }
            : {}),
      }
    }
  } catch {
    // Fall back to the file timestamp when
    // the content is not inside a Git repository.
  }

  return {
    modifiedAt: fs
        .statSync(filePath)
        .mtime
        .toISOString(),
  }
}

function resolveContentUrl(url, context, node) {
  if (!url) {
    fail(
        context.filePath,
        node,
        'empty URL',
    )
  }

  if (/^[a-z][a-z\d+.-]*:/i.test(url)) {
    let parsed

    try {
      parsed = new URL(url)
    } catch {
      fail(
          context.filePath,
          node,
          `invalid URL: ${url}`,
      )
    }

    if (
        !SAFE_REMOTE_PROTOCOLS.has(
            parsed.protocol,
        )
    ) {
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

  const [
    pathname,
    suffix = '',
  ] = url.split(
      /(?=[?#])/u,
      2,
  )

  const absolutePath = path.resolve(
      path.dirname(context.filePath),
      pathname,
  )

  const relativePath = path.relative(
      context.contentDir,
      absolutePath,
  )

  if (
      relativePath.startsWith('..') ||
      path.isAbsolute(relativePath)
  ) {
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

  return `/wiki-content/${relativePath.replaceAll(
      path.sep,
      '/',
  )}${suffix}`
}

function internalSlug(url) {
  const clean = url
      .replace(
          /^\/wiki\//,
          '/',
      )
      .replace(
          /^\//,
          '',
      )
      .replace(
          /\/$/,
          '',
      )

  return clean || undefined
}

function inlineNodes(nodes, context) {
  return nodes.flatMap((node) => {
    switch (node.type) {
      case 'text':
        return [
          node.value,
        ]

      case 'strong':
        return [
          {
            type: 'strong',
            children: inlineNodes(
                node.children,
                context,
            ),
          },
        ]

      case 'emphasis':
        return [
          {
            type: 'em',
            children: inlineNodes(
                node.children,
                context,
            ),
          },
        ]

      case 'delete':
        return [
          {
            type: 'strike',
            children: inlineNodes(
                node.children,
                context,
            ),
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
        return [
          '\n',
        ]

      case 'link': {
        const children = inlineNodes(
            node.children,
            context,
        )

        if (
            node.url.startsWith('/') &&
            !node.url.startsWith('//')
        ) {
          return [
            {
              type: 'link',
              children,
              slug: internalSlug(
                  node.url,
              ),
            },
          ]
        }

        return [
          {
            type: 'link',
            children,
            href: resolveContentUrl(
                node.url,
                context,
                node,
            ),
          },
        ]
      }

      case 'textDirective': {
        if (
            node.name !== 'underline' &&
            node.name !== 'spoiler'
        ) {
          fail(
              context.filePath,
              node,
              `unsupported inline directive: ${node.name}`,
          )
        }

        return [
          {
            type: node.name,
            children: inlineNodes(
                node.children,
                context,
            ),
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
  const attributes =
      node.attributes ?? {}

  const level = Number(
      attributes.level ?? 2,
  )

  if (
      ![
        1,
        2,
        3,
      ].includes(level)
  ) {
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
      src: resolveContentUrl(
          attributes.icon,
          context,
          node,
      ),

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

  if (
      attributes.gradientFrom ||
      attributes.gradientTo
  ) {
    if (
        !attributes.gradientFrom ||
        !attributes.gradientTo
    ) {
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

/**
 * Gallery deliberately contains only normal Markdown images.
 *
 * Width is not supported inside gallery because WikiGalleryImage
 * currently contains only:
 *
 * src
 * alt
 * position
 *
 * and WikiGallery does not pass width to WikiImage.
 */
function parseGalleryDirective(node, context) {
  const images = []

  for (
      const child
      of node.children ?? []
      ) {
    if (
        child.type !== 'paragraph' ||
        child.children.length !== 1 ||
        child.children[0].type !== 'image'
    ) {
      fail(
          context.filePath,
          child,
          'gallery directive may contain only Markdown images',
      )
    }

    const image =
        child.children[0]

    images.push({
      src: resolveContentUrl(
          image.url,
          context,
          image,
      ),

      ...(image.alt
          ? {
            alt: image.alt,
          }
          : {}),
    })
  }

  if (
      images.length === 0
  ) {
    fail(
        context.filePath,
        node,
        'gallery directive requires at least one image',
    )
  }

  return {
    type: 'gallery',
    images,
  }
}

function parseMarkdownImageParagraph(
    node,
    context,
) {
  const image =
      node.children[0]

  if (
      image?.type !== 'image'
  ) {
    return undefined
  }

  if (
      node.children.length === 1
  ) {
    return {
      type: 'image',

      src: resolveContentUrl(
          image.url,
          context,
          image,
      ),

      ...(image.alt
          ? {
            alt: image.alt,
          }
          : {}),
    }
  }

  const suffix = node.children
      .slice(1)
      .map(textContent)
      .join('')

  return {
    type: 'image',

    src: resolveContentUrl(
        image.url,
        context,
        image,
    ),

    ...(image.alt
        ? {
          alt: image.alt,
        }
        : {}),

    width: parseImageWidthSuffix(
        suffix,
        context.filePath,
        node,
    ),
  }
}

function blockNodes(nodes, context) {
  const blocks = []

  for (const node of nodes) {
    switch (node.type) {
      case 'yaml':
        break

      case 'heading':
        blocks.push({
          type: 'heading',
          level: node.depth,
          text: textContent(
              node,
          ).trim(),
        })

        break

      case 'paragraph': {
        const image =
            parseMarkdownImageParagraph(
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
        const items =
            node.children.map(
                (item) => {
                  if (
                      item.children.length !== 1 ||
                      item.children[0].type !==
                      'paragraph'
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
                },
            )

        blocks.push({
          type: 'list',
          ordered: Boolean(
              node.ordered,
          ),
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
        const rows =
            node.children.map(
                (row) =>
                    row.children.map(
                        (cell) =>
                            inlineNodes(
                                cell.children,
                                context,
                            ),
                    ),
            )

        const headers =
            rows.shift() ?? []

        blocks.push({
          type: 'table',
          headers,
          rows,

          ...(node.align?.some(
              Boolean,
          )
              ? {
                align:
                    node.align.map(
                        (alignment) =>
                            alignment ??
                            'left',
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
                language:
                node.lang,
              }
              : {}),
        })

        break

      case 'containerDirective': {
        if (
            node.name === 'gallery'
        ) {
          blocks.push(
              parseGalleryDirective(
                  node,
                  context,
              ),
          )

          break
        }

        if (
            node.name === 'tip' ||
            node.name === 'info'
        ) {
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

        fail(
            context.filePath,
            node,
            `unsupported block directive: ${node.name}`,
        )

        break
      }

      case 'leafDirective': {
        const attributes =
            node.attributes ?? {}

        if (
            node.name === 'youtube'
        ) {
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
          if (!attributes.src) {
            fail(
                context.filePath,
                node,
                'image directive requires src',
            )
          }

          blocks.push({
            type: 'image',

            src: resolveContentUrl(
                attributes.src,
                context,
                node,
            ),

            ...(attributes.alt
                ? {
                  alt:
                  attributes.alt,
                }
                : {}),

            ...(attributes.width !==
            undefined
                ? {
                  width:
                      parseImageWidth(
                          attributes.width,
                          context.filePath,
                          node,
                      ),
                }
                : {}),
          })
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
      .flatMap(
          (entry) => {
            const entryPath =
                path.join(
                    directory,
                    entry.name,
                )

            if (
                entry.isDirectory()
            ) {
              return markdownFiles(
                  entryPath,
              )
            }

            return (
                entry.isFile() &&
                entry.name.endsWith(
                    '.md',
                )
            )
                ? [
                  entryPath,
                ]
                : []
          },
      )
}

export function loadWikiContent(
    contentDir,
) {
  const resolvedContentDir =
      path.resolve(contentDir)

  const articlesDir =
      path.join(
          resolvedContentDir,
          'articles',
      )

  if (
      !fs.existsSync(
          articlesDir,
      )
  ) {
    throw new Error(
        `Wiki articles directory does not exist: ${articlesDir}`,
    )
  }

  const processor =
      unified()
          .use(remarkParse)
          .use(
              remarkFrontmatter,
              [
                'yaml',
              ],
          )
          .use(remarkGfm)
          .use(remarkDirective)

  const articles =
      markdownFiles(
          articlesDir,
      ).map(
          (filePath) => {
            const source =
                fs.readFileSync(
                    filePath,
                    'utf8',
                )

            const tree =
                processor.parse(
                    source,
                )

            const frontmatterNode =
                tree.children.find(
                    (node) =>
                        node.type ===
                        'yaml',
                )

            if (
                !frontmatterNode
            ) {
              fail(
                  filePath,
                  tree,
                  'YAML frontmatter is required',
              )
            }

            const metadata =
                YAML.parse(
                    frontmatterNode.value,
                ) ?? {}

            const slug =
                normalizeSlugFromFile(
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
                typeof metadata.title !==
                'string' ||
                !metadata.title.trim()
            ) {
              fail(
                  filePath,
                  frontmatterNode,
                  'frontmatter title is required',
              )
            }

            const context = {
              contentDir:
              resolvedContentDir,
              filePath,
            }

            const {
              modifiedAt,
              modifiedBy,
            } =
                lastModification(
                    resolvedContentDir,
                    filePath,
                )

            const article = {
              slug,

              title:
                  metadata.title.trim(),

              order:
                  Number.isFinite(
                      Number(
                          metadata.order,
                      ),
                  )
                      ? Number(
                          metadata.order,
                      )
                      : 999,

              lastModifiedAt:
              modifiedAt,

              ...(modifiedBy
                  ? {
                    lastModifiedBy:
                    modifiedBy,
                  }
                  : {}),

              blocks:
                  blockNodes(
                      tree.children,
                      context,
                  ),
            }

            if (
                metadata.banner
            ) {
              if (
                  typeof metadata.banner !==
                  'object' ||
                  typeof metadata.banner.src !==
                  'string'
              ) {
                fail(
                    filePath,
                    frontmatterNode,
                    'banner.src is required',
                )
              }

              article.banner = {
                src:
                    resolveContentUrl(
                        metadata.banner.src,
                        context,
                        frontmatterNode,
                    ),

                ...(metadata.banner.alt
                    ? {
                      alt: String(
                          metadata.banner.alt,
                      ),
                    }
                    : {}),

                ...(metadata.banner.position
                    ? {
                      position:
                          String(
                              metadata.banner.position,
                          ),
                    }
                    : {}),
              }
            }

            return article
          },
      )

  const seenSlugs =
      new Set()

  for (
      const article
      of articles
      ) {
    if (
        seenSlugs.has(
            article.slug,
        )
    ) {
      throw new Error(
          `Duplicate wiki slug: ${article.slug}`,
      )
    }

    seenSlugs.add(
        article.slug,
    )
  }

  const brokenLinks = []

  const visitInline = (
      nodes,
      article,
  ) => {
    for (
        const node
        of nodes
        ) {
      if (
          typeof node ===
          'string'
      ) {
        continue
      }

      if (
          node.type ===
          'link' &&
          node.slug &&
          !seenSlugs.has(
              node.slug,
          )
      ) {
        brokenLinks.push(
            `${article.slug} -> ${node.slug}`,
        )
      }

      if (
          'children' in node
      ) {
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
    for (
        const block
        of blocks
        ) {
      if (
          block.type ===
          'paragraph'
      ) {
        visitInline(
            block.children,
            article,
        )
      }

      if (
          block.type ===
          'list'
      ) {
        block.items.forEach(
            (item) =>
                visitInline(
                    item,
                    article,
                ),
        )
      }

      if (
          block.type ===
          'table'
      ) {
        block.headers.forEach(
            (cell) =>
                visitInline(
                    cell,
                    article,
                ),
        )

        block.rows
            .flat()
            .forEach(
                (cell) =>
                    visitInline(
                        cell,
                        article,
                    ),
            )
      }

      if (
          block.type ===
          'quote' ||
          block.type ===
          'callout'
      ) {
        visitBlocks(
            block.blocks,
            article,
        )
      }
    }
  }

  articles.forEach(
      (article) =>
          visitBlocks(
              article.blocks,
              article,
          ),
  )

  if (
      brokenLinks.length
  ) {
    throw new Error(
        `Broken internal wiki links:\n${brokenLinks.join('\n')}`,
    )
  }

  return articles.sort(
      (a, b) =>
          a.order -
          b.order ||
          a.slug.localeCompare(
              b.slug,
              'ru',
          ),
  )
}