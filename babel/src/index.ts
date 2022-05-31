import { template, types as t, PluginObj, NodePath } from '@babel/core';
import generate from '@babel/generator';
import hash from '@emotion/hash';
import { PluginState, PluginOptions } from './types';
import { buildImport, buildModuleExport, buildNamedExport } from './utils';
import { styledComponentsVisitor } from './visitors/styled-components';

export { PluginOptions };

// TODO: target VariableDeclarator instead of VariableDeclaration
export function comptimeCssBabelPlugin(
  opts: PluginOptions
): PluginObj<PluginState> {
  return {
    name: 'comptime-css-babel',
    visitor: {
      Program: {
        enter(path, state) {
          state.dependentNodes = new Set();
          state.styledNodes = [];

          path.traverse(styledComponentsVisitor(path), state);
        },
        exit(path, state) {
          let ast = buildModuleExport({
            nodes: t.objectExpression(
              state.styledNodes.map(node =>
                t.objectProperty(
                  t.identifier(node.ident),
                  t.identifier(node.ident)
                )
              )
            ),
          });

          const program = t.program(
            [...(state.dependentNodes as any), ast].map(path => {
              if (!('parent' in path)) return path;
              if (path.parent.type === 'Program') {
                return path.node as any;
              } else {
                return path.parent as any;
              }
            })
          );

          let cssExtract = generate(program).code;

          let cssFile = `extracted_${hash(cssExtract)}.css.ts`;

          // TODO: convert multiple imports/exports to one
          for (const name of state.styledNodes) {
            path.unshiftContainer(
              'body',
              buildImport({
                specifier: t.identifier(name.ident),
                alias: t.identifier(name.ident),
                // source: t.stringLiteral(
                //   `${cssFile}?from=${Buffer.from(opts.path, 'utf8').toString(
                //     'base64'
                //   )}`
                // ),
                source: t.stringLiteral(cssFile),
              })
            );

            if (name.shouldExport) {
              path.pushContainer(
                'body',
                buildNamedExport({ ident: name.ident })
              );
            }
          }

          opts.result = [cssFile, cssExtract];
        },
      },
      VariableDeclaration(variablePath, variableState) {
        const declarations = variablePath.get('declarations');

        if (declarations.length < 1) return;

        const decl = declarations[0].get('init');
        const id = declarations[0].get('id');

        if (!decl.isCallExpression()) return;
        if (!id.isArrayPattern() && !id.isIdentifier()) return;

        const extractionAPIs = [
          // @vanilla-extract/css
          'style',
          'styleVariants',
          'globalStyle',
          'createTheme',
          'createGlobalTheme',
          'createThemeContract',
          'createGlobalThemeContract',
          'assignVars',
          'createVar',
          'fallbackVar',
          'fontFace',
          'globalFontFace',
          'keyframes',
          'globalKeyframes',
          'style',
          'styleVariants',
          'globalStyle',
          'createTheme',
          'createGlobalTheme',
          'createThemeContract',
          'createGlobalThemeContract',
          'assignVars',
          'createVar',
          'fallbackVar',
          'fontFace',
          'globalFontFace',
          'keyframes',
          'globalKeyframes',
          // @vanilla-extract/recipes
          'recipe',
        ];
        // const recipeAPIs = ['recipe'];

        if (
          !extractionAPIs.some(api =>
            decl.get('callee').referencesImport('comptime-css', api)
          )
        ) {
          return;
        }

        for (const key in decl.scope.bindings) {
          const binding = decl.scope.bindings[key];
          if (binding && key) {
            variableState.dependentNodes.add(binding.path);
          }
        }

        const shouldExport = variablePath.parentPath.isExportNamedDeclaration();

        if (id.isArrayPattern()) {
          for (const elementPath of id.get('elements')) {
            if (elementPath.isIdentifier()) {
              variableState.styledNodes.push({
                shouldExport,
                ident: elementPath.node.name,
              });
            }
          }
        } else {
          variableState.styledNodes.push({
            shouldExport,
            ident: id.node.name,
          });
        }

        variablePath.remove();
      },
    },
  };
}
