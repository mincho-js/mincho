import { types as t, type NodePath } from "@babel/core";
import { isBuiltin } from "node:module";
import {
  getModuleReference,
  getModuleRuntimeDemandOrigin,
  isProvenModuleDataRead,
  type ModuleReference
} from "../commonjs/bindings.js";
import type { MinchoBabelFileMetadata, ProgramScope } from "../types.js";
import { hasDynamicScope } from "./dynamicScope.js";
import { closedRuntimeString } from "./runtimeSourceReference.js";
import { builtInExtractionCalls } from "../extractionCalls/builtins.js";
import {
  invocationStep,
  isProvablyUnexecuted,
  planEvaluation
} from "../extractionCalls/evaluation.js";
import { getStaticCssEvalLiteralRequireImportPath } from "../staticCssEval/cjsBindings.js";
import { getCjsAssignmentTarget } from "../staticCssEval/cjsExportTargets.js";

export interface OriginalModuleRequests {
  statements?: ReadonlySet<t.Statement>;
  requires: ReadonlyMap<t.CallExpression, number>;
}

export function hasConfiguredGeneratorOverride(options: unknown): boolean {
  const effective = options as
    | {
        plugins?: readonly unknown[];
        presets?: readonly { plugins?: readonly unknown[] }[];
      }
    | undefined;
  return [
    ...(effective?.plugins ?? []),
    ...(effective?.presets ?? []).flatMap((preset) => preset.plugins ?? [])
  ].some(
    (plugin) =>
      plugin !== null &&
      typeof plugin === "object" &&
      "generatorOverride" in plugin &&
      typeof plugin.generatorOverride === "function"
  );
}

/** Authoring imports already evaluated in the sidecar need no client runtime. */
export function removeUnusedExtractedImports(
  program: NodePath<t.Program>,
  originalModuleRequests?: OriginalModuleRequests,
  optionalSites?: MinchoBabelFileMetadata["minchoOptionalCommonJsSites"],
  generator?: { sites?: MinchoBabelFileMetadata["minchoOptionalEsmImports"] }
): void {
  const data = (program.scope as ProgramScope).minchoData;
  if (!data || hasDynamicScope(program)) return;

  const extracted = new Set(data.nodes);
  if (!extracted.size) return;
  const extractedBindings = new Set(data.bindings.map(({ node }) => node));

  program.scope.crawl();
  const candidates: {
    declaration: NodePath<t.VariableDeclarator>;
    reference: ModuleReference;
    names: readonly string[];
    initializesSource: boolean;
    requests: t.CallExpression[];
    originalOrder?: number;
  }[] = [];
  for (const path of program.get("body")) {
    if (!path.isVariableDeclaration() || !extracted.has(path.node)) continue;
    for (const declaration of path.get("declarations")) {
      if (!extractedBindings.has(declaration.node)) continue;
      const init = declaration.get("init");
      if (!init.isExpression()) continue;
      const reference = getModuleReference(init);
      if (!reference || reference.unsafe) continue;
      const names = Object.hasOwn(builtInExtractionCalls, reference.source)
        ? builtInExtractionCalls[reference.source]
        : undefined;
      if (!names) continue;

      const requests: t.CallExpression[] = [];
      let originalOrder: number | undefined;
      const collectRequire = (call: NodePath<t.CallExpression>) => {
        if (
          getStaticCssEvalLiteralRequireImportPath(call.node, call.scope) !==
          reference.source
        )
          return;
        requests.push(call.node);
        const order = originalModuleRequests?.requires.get(call.node);
        if (order !== undefined)
          originalOrder = Math.min(originalOrder ?? order, order);
      };
      if (init.isCallExpression()) collectRequire(init);
      init.traverse({ CallExpression: collectRequire });
      candidates.push({
        declaration,
        reference,
        names,
        initializesSource: requests.length > 0,
        requests,
        originalOrder
      });
    }
  }

  // Plan the complete dead alias chain before deciding which sources still
  // execute at runtime. A reference inside another dead declaration is unused.
  const removed = new Set<t.Node>();
  const isRemoved = (path: NodePath<t.Node>) =>
    removed.has(path.node) ||
    Boolean(path.findParent((parent) => removed.has(parent.node)));
  const unused = (path: NodePath<t.Node>, name: string) => {
    const binding = path.scope.getBinding(name);
    return binding?.constant && binding.referencePaths.every(isRemoved);
  };
  let changed: boolean;
  do {
    const size = removed.size;
    for (const { declaration, reference, names } of candidates) {
      if (removed.has(declaration.node)) continue;
      const pattern = declaration.get("id");
      if (pattern.isIdentifier()) {
        if (
          (!reference.members.length ||
            (reference.members.length === 1 &&
              names.includes(reference.members[0]!))) &&
          unused(pattern, pattern.node.name)
        )
          removed.add(declaration.node);
        continue;
      }
      if (
        !pattern.isObjectPattern() ||
        reference.members.length ||
        pattern.node.properties.some((property) => t.isRestElement(property))
      )
        continue;

      for (const property of pattern.get("properties")) {
        if (
          !property.isObjectProperty() ||
          property.node.computed ||
          !t.isIdentifier(property.node.value)
        )
          continue;
        const key = property.node.key;
        const name = t.isIdentifier(key)
          ? key.name
          : t.isStringLiteral(key)
            ? key.value
            : undefined;
        if (
          name &&
          names.includes(name) &&
          unused(property, property.node.value.name)
        )
          removed.add(property.node);
      }

      if (pattern.node.properties.every((property) => removed.has(property)))
        removed.add(declaration.node);
    }
    changed = removed.size !== size;
  } while (changed);

  const runtimeRequires = new Set<string>();
  const authoredRequireSources = new Map<string, number>();
  const selectedEsmUses = new Set<string>();
  const liveImportedUses: {
    source: string;
    position?: number;
    kind: "call" | "publication" | "access";
  }[] = [];
  const liveImportedUse = (
    use: NodePath,
    kind: "call" | "publication" | "access",
    site: NodePath,
    selectedConsumption = false
  ) => {
    const reference =
      kind === "access"
        ? getModuleRuntimeDemandOrigin(use)
        : getModuleReference(use);
    if (
      selectedConsumption &&
      reference?.kind === "import" &&
      !reference.unsafe &&
      /^\.{1,2}\//.test(reference.source) &&
      !isProvablyUnexecuted(site)
    ) {
      if (isEagerProgramUse(site)) selectedEsmUses.add(reference.source);
    }
    if (
      reference?.kind === "require" &&
      !reference.unsafe &&
      (reference.source.startsWith("./") ||
        reference.source.startsWith("../") ||
        // Native execution has no staged host dependency graph for a bare
        // requested package. Its actual later invocation can observe init.
        (!optionalSites &&
          kind === "call" &&
          /^(?:@[^/]+\/)?[A-Za-z0-9][^\s:]*$/.test(reference.source) &&
          !isBuiltin(reference.source))) &&
      !isProvablyUnexecuted(site)
    )
      liveImportedUses.push({
        source: reference.source,
        position: kind === "publication" ? undefined : statementPosition(site),
        kind
      });
  };
  const statementPosition = (path: NodePath): number | undefined => {
    if (path.getFunctionParent()) return;
    const statement = path.getStatementParent();
    if (statement?.parentPath === program && typeof statement.key === "number")
      return statement.key;
  };
  const isEagerProgramUse = (site: NodePath): boolean => {
    // ESM evaluates static dependencies before any reachable Program body,
    // regardless of where the import happens to appear in source text.
    for (let item = site; item.parentPath; item = item.parentPath) {
      if (item.isFunction() || item.isClass()) return false;
      if (item.parentPath === program) return true;
    }
    return false;
  };
  let unknownRuntimeRequire = false;
  const liveOriginal: {
    node: t.CallExpression;
    source: string;
    order: number;
    deferred: boolean;
  }[] = [];
  let lastOriginalRuntimeRequire = -1;
  let deferredOriginalRuntimeRequire = false;
  program.traverse({
    enter(path) {
      if (removed.has(path.node)) path.skip();
    },
    "CallExpression|OptionalCallExpression|NewExpression|TaggedTemplateExpression"(
      path
    ) {
      if (optionalSites && path.isNewExpression()) return;
      const target = invocationStep(path)?.invocation?.callee;
      if (target)
        // A tag can be a callable CommonJS namespace. This demand only
        // preserves an authored load; extraction need not trust its shape.
        liveImportedUse(
          target,
          path.isTaggedTemplateExpression() ? "access" : "call",
          path,
          true
        );
    },
    "BinaryExpression|ForOfStatement"(path) {
      // Both output modes can observe the earlier authored load through
      // selected coercion or iteration at the actual consuming statement.
      if (path.isBinaryExpression() && path.node.operator !== "+") return;
      for (const step of planEvaluation(path).steps) {
        if (step.kind === "coerce") liveImportedUse(step.path, "access", path);
        else if (
          step.kind === "observe" &&
          step.sourceDelivery?.kind === "sync-iterator"
        )
          liveImportedUse(step.sourceDelivery.after, "access", path, true);
      }
    },
    "MemberExpression|OptionalMemberExpression"(path) {
      // Observable child accessors require native CommonJS order. The staged
      // ESM normalizer has a separate runtime-graph demand policy and does not
      // support accessor-dependent module initialization.
      if (
        optionalSites ||
        (!path.isMemberExpression() && !path.isOptionalMemberExpression())
      )
        return;
      const parent = path.parentPath;
      if (parent.isUnaryExpression({ operator: "delete" })) return;
      const writes =
        (parent.isAssignmentExpression() && path.key === "left") ||
        parent.isUpdateExpression();
      if (!writes && isProvenModuleDataRead(path)) return;
      // Both getting and storing the selected child property can invoke
      // ordinary accessors. A read-only descriptor proof is not a write
      // proof, and evaluating an assignment does not require a getter first.
      liveImportedUse(path, "access", path);
    },
    AssignmentExpression(path) {
      if (path.node.operator !== "=") return;
      const target = getCjsAssignmentTarget(path.node.left, path.scope);
      if (target.kind === "property" || target.kind === "module-replacement")
        liveImportedUse(path.get("right"), "publication", path);
    },
    ReferencedIdentifier(path) {
      if (
        !path.isIdentifier({ name: "require" }) ||
        path.scope.getBinding("require")
      )
        return;
      const call = path.parentPath;
      const source =
        call.isCallExpression() && call.node.callee === path.node
          ? getStaticCssEvalLiteralRequireImportPath(call.node, call.scope)
          : null;
      // Escaped loaders and dynamic specifiers can request any source, so their
      // surviving uses still require the original initialization order.
      if (source === null) {
        unknownRuntimeRequire = true;
      } else {
        runtimeRequires.add(source);
        const order = call.isCallExpression()
          ? originalModuleRequests?.requires.get(call.node)
          : undefined;
        if (order !== undefined && !isProvablyUnexecuted(call)) {
          authoredRequireSources.set(
            source,
            Math.min(authoredRequireSources.get(source) ?? order, order)
          );
          lastOriginalRuntimeRequire = Math.max(
            lastOriginalRuntimeRequire,
            order
          );
          const deferred = Boolean(call.getFunctionParent());
          if (deferred) deferredOriginalRuntimeRequire = true;
          if (optionalSites && call.isCallExpression())
            liveOriginal.push({ node: call.node, source, order, deferred });
        }
      }
    }
  });

  const sourcePlans = candidates.map((candidate) => {
    const { declaration, reference, originalOrder } = candidate;
    const position = statementPosition(declaration);
    // An earlier module load does not finish work reached through a later
    // invocation of its exported function. Keep the authored initialization
    // where the later live consumer may observe it. A merely loaded child
    // (or a known earlier call) does not add later demand.
    const deferredChildUse =
      originalOrder !== undefined &&
      liveImportedUses.some((use) => {
        const childOrder = authoredRequireSources.get(use.source);
        return (
          childOrder !== undefined &&
          // The normalizer already stages a later authored child load against
          // the emitted runtime graph. The new accessor case covers the gap
          // for children originally loaded earlier; do not turn a later
          // optional site into an eagerly required binding before generation.
          (use.kind !== "access" || childOrder < originalOrder) &&
          (use.position === undefined ||
            position === undefined ||
            use.position >= position)
        );
      });
    const required =
      unknownRuntimeRequire ||
      runtimeRequires.has(reference.source) ||
      deferredChildUse;
    const later =
      originalOrder !== undefined &&
      (deferredOriginalRuntimeRequire ||
        lastOriginalRuntimeRequire > originalOrder);
    return { ...candidate, required, later };
  });
  const stagedSources = new Set(
    sourcePlans.flatMap(({ reference, initializesSource, originalOrder }) =>
      // All already-proven alias candidates belonging to an authored
      // load enter the same final reader reconciliation, even when the
      // loader itself has a live reader.
      optionalSites && initializesSource && originalOrder !== undefined
        ? [reference.source]
        : []
    )
  );
  for (const {
    declaration,
    reference,
    initializesSource,
    requests,
    originalOrder,
    required,
    later
  } of sourcePlans) {
    const retainInitialization = initializesSource && (required || later);
    const stageAlias =
      !initializesSource && stagedSources.has(reference.source);
    const stage = (property?: t.ObjectProperty) => {
      optionalSites?.push({
        declaration: declaration.node,
        stagedShape: t.cloneNode(declaration.node),
        ...(property ? { property } : {}),
        members: reference.members,
        requests,
        source: reference.source,
        later:
          originalOrder === undefined
            ? []
            : liveOriginal.filter(
                (entry) => !entry.deferred && entry.order > originalOrder
              )
      });
    };
    if (
      optionalSites &&
      removed.has(declaration.node) &&
      (stageAlias ||
        (initializesSource && originalOrder !== undefined && !required))
    ) {
      // Even without a later require, the one configured generator may
      // add a reader of this otherwise dead authored binding.
      stage();
      continue;
    }
    if (removed.has(declaration.node) && !retainInitialization) {
      declaration.remove();
      continue;
    }
    const pattern = declaration.get("id");
    if (pattern.isObjectPattern())
      for (const property of pattern.get("properties")) {
        if (!removed.has(property.node)) continue;
        if (
          optionalSites &&
          (originalOrder !== undefined || stageAlias) &&
          property.isObjectProperty()
        )
          stage(property.node);
        else property.remove();
      }
  }

  // Removing a destructured authoring binding can make its namespace import
  // unused. Recompute references after pruning, independent of statement order.
  program.scope.crawl();
  const body = program.get("body");
  const emptied = new Set<t.ImportDeclaration>();
  for (const path of body) {
    if (!path.isImportDeclaration() || !extracted.has(path.node)) continue;

    const names = Object.hasOwn(builtInExtractionCalls, path.node.source.value)
      ? builtInExtractionCalls[path.node.source.value]
      : undefined;
    if (!names) continue;

    const dead = new Set<t.Node>();
    const prune = (specifier: NodePath<t.Node>) => {
      dead.add(specifier.node);
      if (!generator) specifier.remove();
    };
    for (const specifier of path.get("specifiers")) {
      const binding = program.scope.getBinding(specifier.node.local.name);
      if (specifier.isImportNamespaceSpecifier()) {
        if (binding?.constant && !binding.referenced) prune(specifier);
        continue;
      }
      if (!specifier.isImportSpecifier()) continue;

      const imported = specifier.node.imported;
      const name = t.isIdentifier(imported) ? imported.name : imported.value;

      if (names.includes(name) && binding?.constant && !binding.referenced)
        prune(specifier);
    }

    if (
      path.node.specifiers.every((specifier) => dead.has(specifier)) &&
      !data.effectImports?.has(path.node.source.value)
    )
      emptied.add(path.node);
  }
  if (!emptied.size) return;

  // Later surviving imports and value re-exports still evaluate this source.
  // Keep its first equivalent request in that case, not an extra request for
  // a source that is no longer used at runtime.
  const request = (
    node:
      t.ImportDeclaration | t.ExportNamedDeclaration | t.ExportAllDeclaration
  ) => {
    const attributes = node.attributes ?? node.assertions ?? [];
    const entries = attributes.map(({ key, value }) =>
      JSON.stringify([t.isIdentifier(key) ? key.name : key.value, value.value])
    );
    return JSON.stringify([
      node.source?.value,
      t.isImportDeclaration(node) ? (node.phase ?? null) : null,
      entries.sort()
    ]);
  };
  const laterRequests = new Map<string, number>();
  const isValueReexport = (
    node: t.Statement
  ): node is t.ExportNamedDeclaration | t.ExportAllDeclaration =>
    (t.isExportAllDeclaration(node) || t.isExportNamedDeclaration(node)) &&
    node.source != null &&
    node.exportKind !== "type" &&
    (!t.isExportNamedDeclaration(node) ||
      !node.specifiers.length ||
      node.specifiers.some(
        (specifier) =>
          !t.isExportSpecifier(specifier) || specifier.exportKind !== "type"
      ));
  const isValueImport = (node: t.ImportDeclaration) =>
    node.importKind !== "type" &&
    node.importKind !== "typeof" &&
    (!node.specifiers.length ||
      node.specifiers.some(
        (specifier) =>
          !t.isImportSpecifier(specifier) ||
          (specifier.importKind !== "type" && specifier.importKind !== "typeof")
      ));
  const generated = new Set(
    [...data.imports.values()].map((identifier) => identifier.name)
  );
  const carriesRuntimeRequest = (node: t.ImportDeclaration) =>
    isValueImport(node) &&
    (!node.specifiers.length ||
      node.specifiers.some(
        (specifier) =>
          (!t.isImportSpecifier(specifier) ||
            (specifier.importKind !== "type" &&
              specifier.importKind !== "typeof")) &&
          (!generated.has(specifier.local.name) ||
            program.scope.getBinding(specifier.local.name)?.referenced)
      ));
  let lastAuthoredStaticRequest = -1;
  body.forEach(({ node }, index) => {
    if (
      isValueReexport(node) ||
      (t.isImportDeclaration(node) &&
        !emptied.has(node) &&
        carriesRuntimeRequest(node))
    ) {
      laterRequests.set(request(node), index);
      if (originalModuleRequests?.statements?.has(node))
        lastAuthoredStaticRequest = index;
    }
  });
  const firstOrdinarySources = new Set(
    [...emptied]
      .filter(
        (node) =>
          node.phase == null && !(node.attributes ?? node.assertions)?.length
      )
      .map((node) => node.source.value)
  );
  const dynamicRequests = new Set<string>();
  if (firstOrdinarySources.size) {
    const evaluatesToUndefined = (path: NodePath<t.Node>, node: t.Node) =>
      (t.isIdentifier(node, { name: "undefined" }) &&
        !path.scope.getBinding("undefined")) ||
      // This only classifies the request made on normal completion:
      // the authored operand still runs at its original dynamic import.
      t.isUnaryExpression(node, { operator: "void" });
    const hasEmptyOptions = (
      path: NodePath<t.Node>,
      node: t.Node | null | undefined
    ) => {
      if (node == null || evaluatesToUndefined(path, node)) return true;
      if (t.isIdentifier(node)) {
        const binding = path.scope.getBinding(node.name);
        const declaration = binding?.path;
        if (
          binding?.kind !== "const" ||
          !binding.constant ||
          binding.scope !== program.scope ||
          !declaration?.isVariableDeclarator() ||
          declaration.parentPath.parentPath !== program ||
          declaration.node.end == null ||
          node.start == null ||
          declaration.node.end > node.start ||
          binding.referencePaths.length !== 1 ||
          binding.referencePaths[0]?.node !== node ||
          !t.isObjectExpression(declaration.node.init)
        )
          return false;
        // A single read of a fresh, unaliased object leaves no path to change
        // these attributes. Keep the authored evaluation and TDZ at import().
        return hasEmptyOptions(declaration, declaration.node.init);
      }
      if (!t.isObjectExpression(node)) return false;
      if (node.properties.length === 0) return true;
      const [property] = node.properties;
      return (
        node.properties.length === 1 &&
        t.isObjectProperty(property) &&
        !property.computed &&
        (t.isIdentifier(property.key, { name: "with" }) ||
          t.isStringLiteral(property.key, { value: "with" })) &&
        (evaluatesToUndefined(path, property.value) ||
          (t.isObjectExpression(property.value) &&
            property.value.properties.length === 0))
      );
    };
    const immutableRequestName = (source: NodePath<t.Node> | undefined) => {
      if (!source?.isIdentifier())
        return source ? closedRuntimeString(source) : undefined;
      const owner = source.getFunctionParent();
      const closure = owner?.parentPath;
      const declarationStatement = closure?.parentPath;
      // Only a module-local binding whose initializer creates a callable is
      // deferred here; an immediately evaluated function expression is not.
      const deferredLocalClosure =
        (owner?.isArrowFunctionExpression() || owner?.isFunctionExpression()) &&
        closure?.isVariableDeclarator() &&
        closure.node.init === owner.node &&
        declarationStatement?.isVariableDeclaration() &&
        (declarationStatement.parentPath === program ||
          (declarationStatement.parentPath.isExportNamedDeclaration() &&
            declarationStatement.parentPath.parentPath === program));
      const binding = source.scope.getBinding(source.node.name);
      const declaration = binding?.path;
      if (
        binding?.kind !== "const" ||
        !binding.constant ||
        binding.scope !== program.scope ||
        !declaration?.isVariableDeclarator() ||
        !declaration.get("id").isIdentifier() ||
        declaration.parentPath.parentPath !== program ||
        declaration.node.end == null ||
        source.node.start == null ||
        (declaration.node.end > source.node.start && !deferredLocalClosure)
      )
        return;
      // A deferred use can run before initialization in a cycle. That is not
      // a successful request; after a successful read this immutable value
      // determines the target, without moving the read or its TDZ.
      const initializer = declaration.get("init");
      if (initializer.isExpression() && !initializer.isIdentifier())
        return closedRuntimeString(initializer);
    };
    const retainDynamicRequest = (
      path: NodePath<t.Node>,
      source: NodePath<t.Node> | undefined
    ) => {
      if (isProvablyUnexecuted(path)) return;
      const value = immutableRequestName(source);
      if (value !== undefined && firstOrdinarySources.has(value))
        dynamicRequests.add(JSON.stringify([value, null, []]));
    };
    program.traverse({
      CallExpression(path) {
        if (!t.isImport(path.node.callee)) return;
        const [source] = path.get("arguments");
        if (
          path.node.arguments.length <= 2 &&
          hasEmptyOptions(path, path.node.arguments[1])
        )
          retainDynamicRequest(path, source);
      },
      ImportExpression(path) {
        if (path.node.phase == null && hasEmptyOptions(path, path.node.options))
          retainDynamicRequest(path, path.get("source"));
      }
    });
  }
  // An authored earlier local dependency with actual surviving consumption
  // can observe this initializer. We do not inspect or predict its body.
  const firstSelectedAuthoredDependency = body.findIndex(
    ({ node }) =>
      t.isImportDeclaration(node) &&
      originalModuleRequests?.statements?.has(node) &&
      selectedEsmUses.has(node.source.value) &&
      carriesRuntimeRequest(node)
  );
  const seen = new Set<string>();
  body.forEach((path, index) => {
    const node = path.node;
    if (isValueReexport(node)) {
      seen.add(request(node));
      return;
    }
    if (!t.isImportDeclaration(node)) return;
    const key = request(node);
    const isValue = isValueImport(node);
    if (
      emptied.has(node) &&
      (!isValue ||
        seen.has(key) ||
        (!dynamicRequests.has(key) &&
          (laterRequests.get(key) ?? -1) <= index &&
          !(
            originalModuleRequests?.statements?.has(node) &&
            firstSelectedAuthoredDependency !== -1 &&
            firstSelectedAuthoredDependency < index
          ) &&
          // In the non-codegen profile an unclassified later authored
          // dependency can still initialize this module via an alias or
          // through its own dependencies. Keep the original first request.
          !(
            originalModuleRequests?.statements?.has(node) &&
            lastAuthoredStaticRequest > index
          )))
    ) {
      if (!generator) path.remove();
      else if (node.specifiers.length > 0)
        generator.sites?.push(t.cloneNode(node));
      return;
    }
    if (emptied.has(node) ? isValue : carriesRuntimeRequest(node))
      seen.add(key);
  });
}

/** Generated bindings have no user-requested module effects. Never infer ownership by name. */
export function removeUnusedGeneratedImports(
  program: NodePath<t.Program>
): void {
  const generated = (program.scope as ProgramScope).minchoData?.imports;
  if (!generated?.size) return;

  program.scope.crawl();

  for (const identifier of generated.values()) {
    const binding = program.scope.getBinding(identifier.name);
    if (!binding || binding.referenced || !binding.constant) continue;

    const path = binding.path;

    if (path.isImportSpecifier()) {
      const declaration = path.parentPath;
      path.remove();

      if (
        declaration.isImportDeclaration() &&
        !declaration.node.specifiers.length &&
        !(program.scope as ProgramScope).minchoData.effectImports?.has(
          declaration.node.source.value
        )
      )
        declaration.remove();
    } else if (path.isVariableDeclarator() && t.isIdentifier(path.node.id)) {
      // helper-module-imports emits a private `var _cx = require(...).cx` in CJS.
      const init = path.get("init");

      if (init.isExpression() && getModuleReference(init)) path.remove();
    }
  }
}

/** Syntax proof, never TypeScript annotations: false means retain the runtime check. */
export function primitiveKind(node: t.Node): "value" | "absent" | null {
  if (
    t.isStringLiteral(node) ||
    t.isNumericLiteral(node) ||
    t.isTemplateLiteral(node)
  )
    return "value";
  if (t.isBooleanLiteral(node) || t.isNullLiteral(node)) return "absent";

  if (t.isUnaryExpression(node)) {
    if (["+", "-", "~", "typeof"].includes(node.operator)) return "value";
    if (["!", "void", "delete"].includes(node.operator)) return "absent";
  }

  if (t.isBinaryExpression(node)) {
    if (
      [
        "==",
        "===",
        "!=",
        "!==",
        "<",
        ">",
        "<=",
        ">=",
        "in",
        "instanceof"
      ].includes(node.operator)
    )
      return "absent";

    // `+` also coerces objects, but a successful operation is still primitive.
    return "value";
  }

  if (t.isConditionalExpression(node)) {
    const left = primitiveKind(node.consequent);

    return left === primitiveKind(node.alternate) ? left : null;
  }

  if (t.isSequenceExpression(node))
    return primitiveKind(node.expressions.at(-1)!);
  if (
    t.isTSAsExpression(node) ||
    t.isTSSatisfiesExpression(node) ||
    t.isTSNonNullExpression(node)
  )
    return primitiveKind(node.expression);

  return null;
}

const unknown = Symbol("dynamic class value");

function staticClass(node: t.Node): string | typeof unknown {
  if (t.isStringLiteral(node)) return node.value;
  if (t.isNumericLiteral(node)) return node.value ? String(node.value) : "";
  if (t.isNullLiteral(node) || t.isBooleanLiteral(node)) return "";

  if (t.isArrayExpression(node)) {
    const items: string[] = [];

    for (const item of node.elements) {
      // Holes and object literals can observe inherited enumerable properties.
      if (!item || t.isSpreadElement(item)) return unknown;

      const value = staticClass(item);
      if (value === unknown) return unknown;
      if (value) items.push(value);
    }

    return items.join(" ");
  }

  return unknown;
}

function freshObject(node: t.Node): boolean {
  if (t.isConditionalExpression(node))
    return freshObject(node.consequent) && freshObject(node.alternate);

  return (
    t.isObjectExpression(node) &&
    node.properties.every(
      (property) =>
        t.isObjectProperty(property) &&
        !property.computed &&
        !(
          t.isIdentifier(property.key, { name: "__proto__" }) ||
          t.isStringLiteral(property.key, { value: "__proto__" })
        )
    )
  );
}

/** Reduce only known helpers and fresh literals; expressions with observable reads stay in order. */
export function optimizeRuntimeCodegen(program: NodePath<t.Program>): void {
  if (hasDynamicScope(program)) return;

  program.traverse({
    CallExpression: {
      exit(path) {
        const reference = getModuleReference(path.get("callee"));
        if (!reference || reference.unsafe || path.node.optional) return;

        const args = path.node.arguments;
        if (!args.every((argument) => t.isExpression(argument))) return;

        if (
          reference.members.join(".") === "cx" &&
          ["@mincho-js/css", "@mincho-js/css/classname"].includes(
            reference.source
          )
        ) {
          const reduced: t.Expression[] = [];
          const pending: string[] = [];

          const flush = () => {
            if (pending.length)
              reduced.push(t.stringLiteral(pending.join(" ")));

            pending.length = 0;
          };

          for (const argument of args) {
            const value = staticClass(argument);

            if (value === unknown) {
              flush();
              reduced.push(argument);
            } else if (value) pending.push(value);
          }

          flush();

          if (!reduced.length) path.replaceWith(t.stringLiteral(""));
          else if (reduced.length === 1 && t.isStringLiteral(reduced[0]))
            path.replaceWith(reduced[0]);
          else path.node.arguments = reduced;
        } else if (
          reference.source === "@mincho-js/transform-runtime" &&
          reference.members.join(".") === "vx" &&
          args.length >= 1 &&
          args.length <= 2
        ) {
          const value = args[0]!;
          const suffix = args[1];
          if (suffix && !t.isStringLiteral(suffix) && !t.isNullLiteral(suffix))
            return;

          const kind = primitiveKind(value);

          if (kind === "absent")
            path.replaceWith(
              t.sequenceExpression([value, t.stringLiteral("var(--c-, )")])
            );
          if (kind === "value")
            path.replaceWith(
              t.isStringLiteral(suffix) && suffix.value
                ? t.templateLiteral(
                    [
                      t.templateElement({ raw: "", cooked: "" }),
                      t.templateElement(
                        {
                          raw: suffix.value
                            .replace(/[`\\$]/g, "\\$&")
                            .replace(/\r/g, "\\r"),
                          cooked: suffix.value
                        },
                        true
                      )
                    ],
                    [value]
                  )
                : value
            );
        }
      }
    },
    ObjectExpression: {
      exit(path) {
        // A single fresh branch already is the required snapshot. Do not remove
        // copies of user objects, accessors, methods or custom prototypes.
        const [property] = path.node.properties;

        if (
          path.node.properties.length === 1 &&
          t.isSpreadElement(property) &&
          freshObject(property.argument)
        )
          path.replaceWith(property.argument);
      }
    }
  });
}
