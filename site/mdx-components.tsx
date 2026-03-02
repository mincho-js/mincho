import type { MDXComponents } from 'mdx/types'
import { useMDXComponents as getNextraComponents } from 'nextra/mdx-components'
import { useMDXComponents as getDocsMDXComponents } from 'nextra-theme-docs'

const nextraComponents = getNextraComponents()
const docsComponents = getDocsMDXComponents()

export function useMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...nextraComponents,
    ...docsComponents,
    ...components
  }
}
