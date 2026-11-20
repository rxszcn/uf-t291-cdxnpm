/*!
This file is part of CycloneDX generator for NPM projects.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

   http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.

SPDX-License-Identifier: Apache-2.0
Copyright (c) OWASP Foundation. All Rights Reserved.
*/

const { describe, expect, test } = require('@jest/globals')

const { TreeBuilder } = require('../../dist/builders')

describe('builders.TreeBuilder', () => {
  describe('fromPaths', () => {
    test.each([
      ['distinct dos-like paths', '\\',
        'C:\\foo\\baz',
        [
          'C:\\foo\\bar',
          'C:\\foo\\bar\\bar',
          'D:\\foo\\baz',
          'D:\\foo\\baz\\bar',
          'E:\\foo\\baz',
        ],
        new Map([
          ['C:\\foo\\bar', new Map([
            ['C:\\foo\\bar\\bar', new Map()]
          ])],
          ['D:\\foo\\baz', new Map([
            ['D:\\foo\\baz\\bar', new Map()]
          ])],
          ['E:\\foo\\baz', new Map()]
        ])
      ],
      ['transitive dos-like paths', '\\',
        'C:\\a',
        [
          'C:\\a',
          'C:\\a\\b',
          'C:\\a\\c\\d',
          'C:\\a\\c\\e',
          'C:\\a\\c\\e\\f\\g'
        ],
        new Map([
          ['C:\\a', new Map([
            ['C:\\a\\b', new Map()],
            ['C:\\a\\c\\d', new Map()],
            ['C:\\a\\c\\e', new Map([
              ['C:\\a\\c\\e\\f\\g', new Map()]
            ])]
          ])]
        ])
      ],
      ['distinct paths', '/',
        '/foo/baz',
        [
          '/foo/baz',
          '/foo/baz/bar',
          '/bar/baz',
          '/bar/baz/bar',
          '/baz'
        ],
        new Map([
          ['/foo/baz', new Map([
            ['/foo/baz/bar', new Map()]
          ])],
          ['/bar/baz', new Map([
            ['/bar/baz/bar', new Map()]
          ])],
          ['/baz', new Map()]
        ])
      ],
      ['transitive paths', '/',
        '/a',
        [
          '/a',
          '/a/b',
          '/a/c/d',
          '/a/c/e',
          '/a/c/e/f/g'
        ],
        new Map([
          ['/a', new Map([
            ['/a/b', new Map()],
            ['/a/c/d', new Map()],
            ['/a/c/e', new Map([
              ['/a/c/e/f/g', new Map()]
            ])]
          ])]
        ])
      ]
    ])('%s', (purpose, pathSeparator, root, paths, expected) => {
      const treeBuilder = new TreeBuilder()
      const actual = treeBuilder.fromPaths(root, paths, pathSeparator)
      expect(actual).toMatchObject(expected)
    })
  })

  describe('fromPaths - shape equivalence', () => {
    // region reference implementation
    // the original all-pairs nesting algorithm, kept here as a test oracle.
    // the linear-time implementation under test must produce
    // the exact same tree shape, including the order of Map keys.
    function referenceNestPT (tree) {
      if (tree.size < 2) { return }
      const treeI = Array.from(tree)
      for (const [a, aTree] of treeI) {
        for (const [b, bTree] of treeI) {
          if (a === b) { continue }
          if (b.startsWith(a)) {
            aTree.set(b.slice(a.length), bTree)
            tree.delete(b)
          } else if (a.startsWith(b)) {
            bTree.set(a.slice(b.length), aTree)
            tree.delete(a)
          }
        }
      }
      for (const c of tree.values()) {
        referenceNestPT(c)
      }
    }

    function referenceRenderPR (tree, pref) {
      for (const [p, pTree] of Array.from(tree)) {
        tree.delete(p)
        const pFull = pref + p
        referenceRenderPR(pTree, pFull)
        tree.set(pFull.slice(undefined, -1), pTree)
      }
    }

    function referenceFromPaths (root, paths, dirSeparator) {
      root += dirSeparator
      const upaths = new Set(paths.map(p => `${p}${dirSeparator}`))
      const outs = new Set([...upaths].filter(p => !p.startsWith(root)))
      const inTree = new Map([...upaths].filter(p => !outs.has(p)).map(p => [p, new Map()]))
      referenceNestPT(inTree)
      const outTree = new Map([...outs].map(p => [p, new Map()]))
      referenceNestPT(outTree)
      const tree = new Map()
      outTree.forEach((v, k) => { tree.set(k, v) })
      inTree.forEach((v, k) => { tree.set(k, v) })
      referenceRenderPR(tree, '')
      return tree
    }
    // endregion reference implementation

    // order-sensitive serialization of the tree shape
    const shapeOf = tree => [...tree].map(([k, v]) => [k, shapeOf(v)])

    test.each([
      ['mixed outside/inside paths', '/', '/r',
        ['/r', '/r/a', '/o/x', '/o/x/y', '/r/a/b', '/o/z']],
      ['shuffled transitive paths', '/', '/a',
        ['/a/c/e', '/a', '/a/c/e/f/g', '/a/b', '/a/c/d']],
      ['missing intermediate levels', '/', '/r',
        ['/r', '/r/a/b/c', '/r/a/d', '/r/a/b/e']],
      ['parent inserted after child', '/', '/r',
        ['/r/a/b', '/r', '/r/a']],
      ['deep chain fully shuffled', '/', '/r',
        ['/r/a/b/c/d', '/r/a', '/r/a/b/c', '/r', '/r/a/b']],
      ['dos-like paths', '\\', 'C:\\r',
        ['C:\\r', 'C:\\r\\a', 'D:\\o\\x', 'C:\\r\\a\\b', 'D:\\o']],
      ['wide tree 300 packages', '/', '/r',
        ['/r', ...Array.from({ length: 300 }, (_, i) => `/r/node_modules/pkg${String(i).padStart(6, '0')}`)]]
    ])('same shape as reference: %s', (purpose, pathSeparator, root, paths) => {
      const expected = referenceFromPaths(root, [...paths], pathSeparator)
      const actual = new TreeBuilder().fromPaths(root, [...paths], pathSeparator)
      expect(shapeOf(actual)).toEqual(shapeOf(expected))
    })

    test('same shape as reference: deterministic pseudo-random path sets', () => {
      // seeded PRNG (mulberry32) - deterministic across runs and environments
      let seed = 42
      const rnd = () => {
        seed |= 0; seed = seed + 0x6D2B79F5 | 0 /* eslint-disable-line no-bitwise -- ack */
        let t = Math.imul(seed ^ seed >>> 15, 1 | seed) /* eslint-disable-line no-bitwise -- ack */
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t /* eslint-disable-line no-bitwise -- ack */
        return ((t ^ t >>> 14) >>> 0) / 4294967296 /* eslint-disable-line no-bitwise -- ack */
      }
      const segments = ['a', 'b', 'c', 'd', 'e', 'f']
      for (let round = 0; round < 25; round++) {
        const pool = new Set(['/r'])
        const targetSize = 5 + Math.floor(rnd() * 60)
        while (pool.size < targetSize) {
          const depth = 1 + Math.floor(rnd() * 5)
          let p = rnd() < 0.85 ? '/r' : ''
          for (let d = 0; d < depth; d++) {
            p += '/' + segments[Math.floor(rnd() * segments.length)] + (rnd() < 0.3 ? String(Math.floor(rnd() * 9)) : '')
          }
          pool.add(p)
        }
        const paths = [...pool]
        for (let i = paths.length - 1; i > 0; i--) {
          const j = Math.floor(rnd() * (i + 1));
          [paths[i], paths[j]] = [paths[j], paths[i]]
        }
        const expected = referenceFromPaths('/r', [...paths], '/')
        const actual = new TreeBuilder().fromPaths('/r', [...paths], '/')
        expect(shapeOf(actual)).toEqual(shapeOf(expected))
      }
    })
  })

  describe('fromPaths - scaling', () => {
    // synthetic wide dependency tree: root + N flat packages - zero external dependencies
    const makeWideTreeInput = n => ({
      root: '/synthetic/project',
      paths: [
        '/synthetic/project',
        ...Array.from({ length: n }, (_, i) => `/synthetic/project/node_modules/pkg${String(i).padStart(6, '0')}`)
      ]
    })

    const ROUNDS = 5
    // best-of-rounds is robust against timer jitter for CPU-bound work
    const bestBuildTime = (root, paths) => {
      let best = Number.POSITIVE_INFINITY
      for (let r = 0; r < ROUNDS; r++) {
        const t0 = performance.now()
        new TreeBuilder().fromPaths(root, paths, '/')
        best = Math.min(best, performance.now() - t0)
      }
      return best
    }

    test('wide tree with 8000 packages builds in under 2 seconds', () => {
      const { root, paths } = makeWideTreeInput(8000)
      const elapsed = bestBuildTime(root, paths)
      expect(elapsed).toBeLessThan(2000)
    }, 30000)

    test('doubling a wide tree from 8000 to 16000 packages scales by at most 2.5x', () => {
      const input8000 = makeWideTreeInput(8000)
      const input16000 = makeWideTreeInput(16000)
      const time8000 = bestBuildTime(input8000.root, input8000.paths)
      const time16000 = bestBuildTime(input16000.root, input16000.paths)
      expect(time16000 / time8000).toBeLessThanOrEqual(2.5)
    }, 30000)

    test('wide tree shape: root holds all packages as direct children in input order', () => {
      const { root, paths } = makeWideTreeInput(8000)
      const tree = new TreeBuilder().fromPaths(root, paths, '/')
      expect([...tree.keys()]).toEqual([root])
      expect([...tree.get(root).keys()]).toEqual(paths.slice(1))
    })
  })
})
