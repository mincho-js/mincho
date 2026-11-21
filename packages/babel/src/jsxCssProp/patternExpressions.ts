import type { Binding } from "@babel/traverse";
import { isRuntimeSourceReference } from "../optimizations/runtimeSourceReference.js";
import { observePatternRealm } from "../optimizations/arrayMapIntrinsic.js";
import { types as t, type NodePath } from "@babel/core";
import { staticMemberName } from "../commonjs/bindings.js";
import { unwrapTransparentCssRuleExpression } from "../staticCssEval/candidates.js";
import {
  isCanonicalArrayIndex,
  isObjectPrototypeSetter,
  selectObjectLiteralMember,
  staticObjectMemberName
} from "../staticCssEval/propertySelection.js";

export type PatternOwnReadOperation =
  | { readonly kind: "get"; readonly key: string | null }
  | { readonly kind: "rest" };
export interface PatternSelectionEnvironment {
  /** Existing host evidence for a direct, emitted, primitive import binding. */
  readonly canReadPrimitiveImport?: (binding: Binding) => boolean;
  /** Exact group relocation of iterator effects only, never indexed-value evidence. */
  readonly canReplayIteration?: (source: t.Expression) => boolean;
  /** Exact-source effect/replay authority only; never supplies a selected value or skips defaults. */
  readonly canReplayOwnRead?: (
    source: t.Expression,
    operation: PatternOwnReadOperation
  ) => boolean;
  /** Standard Array iteration, including inherited IteratorClose, remains valid in observed sources. */
  /** A caller may share a fresh observation within a single replay decision. */
  readonly localRealm?: {
    program: NodePath<t.Program>;
    observation: PatternRealmObservation;
  };
  readonly nativeArrayIteration: boolean;
  /** Compiler relocation also needs the same destructuring operations, not only safe defaults. */
  readonly requireReplaySafety?: boolean;
  /** Standard Object/Array prototypes have no additional inherited data slots. */
  readonly standardPrototypeAbsence?: boolean;
  readonly prototypeMutationKeys?: readonly string[] | null;
}

/** Intersect loaded-source receipts with fresh local syntax; never cache across AST edits. */
export function patternSelectionEnvironment(
  program: NodePath<t.Program>,
  observed?: PatternSelectionEnvironment
): PatternSelectionEnvironment {
  return combinePatternEnvironment(
    observed,
    localObservation(program, observed)
  );
}

type PatternRealmObservation = ReturnType<typeof observePatternRealm>;
function localObservation(
  program: NodePath<t.Program>,
  environment?: PatternSelectionEnvironment
) {
  return environment?.localRealm?.program === program
    ? environment.localRealm.observation
    : observePatternRealm(program);
}

function combinePatternEnvironment(
  observed: PatternSelectionEnvironment | undefined,
  local: PatternRealmObservation
): PatternSelectionEnvironment {
  const localKeys = local.keys;
  const externalKeys =
    observed?.prototypeMutationKeys !== undefined
      ? observed.prototypeMutationKeys
      : observed?.standardPrototypeAbsence === false
        ? null
        : [];
  const mergedKeys =
    localKeys === null || externalKeys === null
      ? null
      : [...new Set([...localKeys, ...externalKeys])].sort();
  return {
    canReadPrimitiveImport: observed?.canReadPrimitiveImport,
    requireReplaySafety: observed?.requireReplaySafety,
    canReplayOwnRead: observed?.canReplayOwnRead,
    canReplayIteration: observed?.canReplayIteration,
    nativeArrayIteration:
      observed?.nativeArrayIteration !== false && local.iteration,
    standardPrototypeAbsence:
      observed?.standardPrototypeAbsence !== false &&
      mergedKeys !== null &&
      mergedKeys.length === 0,
    prototypeMutationKeys: mergedKeys
  };
}

/** A var initializer resolves its target through an intervening with object. */
function hasInterceptableVarBinding(
  declaration: NodePath<t.VariableDeclarator> | undefined
): boolean {
  if (!declaration?.parentPath.isVariableDeclaration({ kind: "var" }))
    return false;
  const owner = declaration.parentPath.parentPath;
  if (
    !declaration.node.init &&
    !owner?.isForInStatement() &&
    !owner?.isForOfStatement()
  )
    return false;
  for (
    let child: NodePath<t.Node> = declaration,
      parent: NodePath<t.Node> | null = declaration.parentPath;
    parent && !parent.isFunction();
    child = parent, parent = parent.parentPath
  ) {
    if (parent.isWithStatement() && parent.node.body === child.node)
      return true;
  }
  return false;
}

/** Check computed keys and defaults that may execute during destructuring. */
export function everyPatternExpression(
  pattern: NodePath<t.Node | null | undefined>,
  predicate: (expression: NodePath<t.Node | null | undefined>) => boolean,
  selected?: t.Expression | null,
  skippedDefault?: (pattern: t.AssignmentPattern) => void,
  environment?: PatternSelectionEnvironment
): boolean {
  // Bare bindings contain neither evaluated keys/defaults nor a selection.
  // Avoid a whole-program realm observation when the node walk is a no-op.
  const declarator = pattern.parentPath;
  const bindingMayInvokeSetter = hasInterceptableVarBinding(
    declarator?.isVariableDeclarator() && declarator.node.id === pattern.node
      ? declarator
      : undefined
  );
  if (!pattern.node || pattern.isIdentifier())
    return !bindingMayInvokeSetter || environment?.requireReplaySafety !== true;
  const program = pattern.scope.getProgramParent().path;
  const local = program.isProgram()
    ? localObservation(program, environment)
    : undefined;
  if (
    selected &&
    t.isIdentifier(selected) &&
    hasLocalArrayReceiver(
      pattern,
      selected,
      local ? combinePatternEnvironment(environment, local) : undefined,
      local?.references
    )
  ) {
    const previous = environment?.canReplayIteration;
    environment = {
      nativeArrayIteration: true,
      ...environment,
      // Receiver identity only. Keep selected unknown: this is not a receipt
      // for its element values or for skipping a destructuring default.
      canReplayIteration: (source) =>
        source === selected || !!previous?.(source)
    };
  }
  return everyPatternNodeExpression(
    pattern.node,
    (_, path) => predicate(pattern.get(path) as NodePath<t.Node>),
    selected,
    hasGlobalUndefined(pattern, local),
    "",
    skippedDefault,
    program.isProgram()
      ? combinePatternEnvironment(environment, local!)
      : {
          nativeArrayIteration: false,
          standardPrototypeAbsence: false,
          requireReplaySafety: environment?.requireReplaySafety
        },
    {
      version: 0,
      bindingMayInvokeSetter,
      lexicalRead: lexicalDefaultRead(pattern, local),
      primitiveKey: lexicalPrimitiveKey(
        pattern,
        local,
        environment?.canReadPrimitiveImport
      )
    }
  );
}

/** A closed, ordered local alias chain cannot replace or escape this array's iterator. */
function hasLocalArrayReceiver(
  pattern: NodePath<t.Node | null | undefined>,
  selected: t.Identifier,
  environment: PatternSelectionEnvironment | undefined,
  references: PatternRealmObservation["references"] | undefined
): boolean {
  if (!references) return false;
  const consumer = pattern.parentPath;
  if (!consumer?.isVariableDeclarator() || consumer.node.init !== selected)
    return false;
  const statement = consumer.parentPath;
  const block = statement?.parentPath;
  if (
    !statement?.isVariableDeclaration() ||
    !(block?.isProgram() || block?.isBlockStatement())
  )
    return false;
  const body = (block as NodePath<t.Program | t.BlockStatement>).get("body");
  const declarations = body.flatMap((path) =>
    path.isVariableDeclaration() ? path.get("declarations") : []
  );
  const positions = new Map(
    declarations.map((path, index) => [path.node, index])
  );
  let budget = 64;
  const checked = new Set<t.Node>();
  const origin = (
    name: string,
    use: NodePath<t.VariableDeclarator>
  ): boolean => {
    if (--budget < 0) return false;
    const binding = use.scope.getBinding(name);
    if (
      !binding?.constant ||
      !binding.path.isVariableDeclarator() ||
      !binding.path.get("id").isIdentifier()
    )
      return false;
    const declaration = binding.path;
    const before = positions.get(declaration.node);
    const after = positions.get(use.node);
    if (
      before === undefined ||
      after === undefined ||
      before >= after ||
      !declaration.parentPath.isVariableDeclaration({ kind: "const" })
    )
      return false;
    if (!checked.has(declaration.node)) {
      checked.add(declaration.node);
      for (const reference of references(binding)) {
        const next = reference.parentPath;
        if (
          !next?.isVariableDeclarator() ||
          next.node.init !== reference.node ||
          (positions.get(next.node) ?? -1) <= before
        )
          return false;
        if (next.get("id").isIdentifier()) {
          if (!closedUses(next)) return false;
        } else if (!next.get("id").isArrayPattern()) return false;
      }
    }
    const init = declaration.get("init");
    return (
      (init.isArrayExpression() &&
        !!environment &&
        init.node.elements.every((element, index) =>
          element
            ? !t.isSpreadElement(element)
            : allowsPrototypeAbsence(environment, String(index))
        )) ||
      (init.isIdentifier() && origin(init.node.name, declaration))
    );
  };
  const closedUses = (declaration: NodePath<t.VariableDeclarator>): boolean => {
    if (--budget < 0 || !t.isIdentifier(declaration.node.id)) return false;
    const binding = declaration.scope.getBinding(declaration.node.id.name);
    if (
      !binding?.constant ||
      (binding.kind === "var" &&
        binding.scope.path.isProgram() &&
        binding.scope.path.node.sourceType === "script")
    )
      return false;
    for (const reference of references(binding)) {
      const next = reference.parentPath;
      if (
        !next?.isVariableDeclarator() ||
        next.node.init !== reference.node ||
        (positions.get(next.node) ?? -1) <=
          (positions.get(declaration.node) ?? Infinity)
      )
        return false;
      if (next.get("id").isIdentifier()) {
        if (!closedUses(next)) return false;
      } else if (!next.get("id").isArrayPattern()) return false;
    }
    return true;
  };
  return origin(selected.name, consumer);
}

function hasGlobalUndefined(
  path: NodePath<t.Node | null | undefined>,
  local: PatternRealmObservation | undefined
): boolean {
  return (
    local?.bindingsCurrent === true &&
    !local.hasGlobalEval &&
    !path.scope.getBinding("undefined") &&
    !local.mayHaveUnmodeledShadow(path.scope, "undefined") &&
    !path.findParent((parent) => parent.isWithStatement())
  );
}

/** The normal result is primitive; expression evaluation still belongs to predicate. */
function primitiveKeyResult(
  node: t.Node,
  lexical?: (node: t.Identifier) => boolean
): boolean {
  return (
    t.isStringLiteral(node) ||
    t.isNumericLiteral(node) ||
    t.isBooleanLiteral(node) ||
    t.isNullLiteral(node) ||
    t.isBigIntLiteral(node) ||
    t.isUnaryExpression(node) ||
    (t.isBinaryExpression(node) && node.operator !== "|>") ||
    t.isTemplateLiteral(node) ||
    (t.isIdentifier(node) && lexical?.(node) === true)
  );
}

function lexicalPrimitiveKey(
  path: NodePath<t.Node | null | undefined>,
  local: PatternRealmObservation | undefined,
  canReadPrimitiveImport?: PatternSelectionEnvironment["canReadPrimitiveImport"]
) {
  const readable = lexicalDefaultRead(path, local);
  const dynamic = !!path.findParent((parent) => parent.isWithStatement());
  return (node: t.Identifier): boolean => {
    const binding = path.scope.getBinding(node.name);
    if (binding?.kind === "module")
      return (
        !dynamic &&
        local?.bindingsCurrent === true &&
        isRuntimeSourceReference(binding.path) &&
        canReadPrimitiveImport?.(binding) === true
      );
    return (
      readable(node) &&
      !!binding?.constant &&
      (binding.kind === "const" || local?.hasGlobalEval === false) &&
      !(
        binding.kind !== "const" &&
        binding.scope.path.isProgram() &&
        binding.scope.path.node.sourceType === "script"
      ) &&
      binding.path.isVariableDeclarator() &&
      binding.path.get("id").isIdentifier({ name: node.name }) &&
      !!binding.path.node.init &&
      primitiveKeyResult(binding.path.node.init)
    );
  };
}

/** Scope evidence for reads only; no selected/default value is inferred. */
function lexicalDefaultRead(
  path: NodePath<t.Node | null | undefined>,
  local: PatternRealmObservation | undefined
) {
  const dynamic = !!path.findParent((parent) => parent.isWithStatement());
  return (node: t.Identifier): boolean => {
    if (dynamic || !local?.bindingsCurrent) return false;
    const binding = path.scope.getBinding(node.name);
    if (!binding || !isRuntimeSourceReference(binding.path)) return false;
    if (binding.kind === "param") {
      const fn = binding.path.getFunctionParent();
      return (
        !!fn && !!path.findParent((parent) => parent.node === fn.node.body)
      );
    }
    if (binding.kind !== "const" && binding.kind !== "let") return false;
    const declaration = binding.path;
    if (!declaration.isVariableDeclarator() || !declaration.node.init)
      return false;
    const before = declaration.getStatementParent();
    const after = path.getStatementParent();
    if (
      !before ||
      !after ||
      before.parentPath !== after.parentPath ||
      typeof before.key !== "number" ||
      typeof after.key !== "number"
    )
      return false;
    return before.key < after.key;
  };
}

/** The node form shares selection semantics with lexical NodePath callers.
 * Without a program, the default uses the existing standard-realm assumption.
 * Source-aware callers must pass their observed environment (including loaded
 * dependencies); this is not authority to ignore an observed iterator change.
 */
export function everyPatternNodeExpression(
  pattern: t.Node | null | undefined,
  predicate: (expression: t.Expression, path: string) => boolean,
  selected?: t.Expression | null,
  unboundUndefined = false,
  path = "",
  skippedDefault?: (pattern: t.AssignmentPattern) => void,
  environment: PatternSelectionEnvironment = {
    nativeArrayIteration: true,
    standardPrototypeAbsence: true
  },
  effects: {
    version: number;
    bindingMayInvokeSetter?: boolean;
    lexicalRead?: (node: t.Identifier) => boolean;
    primitiveKey?: (node: t.Identifier) => boolean;
    firstSpreads?: Map<t.ArrayExpression, number>;
  } = { version: 0 }
): boolean {
  const version = effects.version;
  const value = selected && unwrapTransparentCssRuleExpression(selected);
  // This exact root allocation is not reachable by the computed key before
  // binding begins. Nested literal aliases do not inherit this read authority.
  const freshRootOwnRead =
    path === "" &&
    t.isObjectExpression(value) &&
    hasOnlyOwnData(value) &&
    value.properties.every(
      (property) =>
        !isObjectPrototypeSetter(property) ||
        (t.isObjectProperty(property) && t.isNullLiteral(property.value))
    ) &&
    ((environment.standardPrototypeAbsence === true &&
      (environment.prototypeMutationKeys === undefined ||
        (Array.isArray(environment.prototypeMutationKeys) &&
          environment.prototypeMutationKeys.length === 0))) ||
      value.properties.some(
        (property) =>
          isObjectPrototypeSetter(property) &&
          t.isObjectProperty(property) &&
          t.isNullLiteral(property.value)
      ));
  const child = (key: string) => (path ? `${path}.${key}` : key);
  const visit = (
    node: t.Node | null,
    key: string,
    selected?: t.Expression | null
  ) =>
    everyPatternNodeExpression(
      node,
      predicate,
      selected,
      unboundUndefined,
      child(key),
      skippedDefault,
      environment,
      effects
    );

  if (t.isAssignmentPattern(pattern)) {
    // Only fresh literal selections prove that a default cannot execute.
    // Referenced objects may have changed since their declaration.
    const defined =
      t.isLiteral(value) ||
      t.isObjectExpression(value) ||
      t.isArrayExpression(value) ||
      t.isFunctionExpression(value) ||
      t.isArrowFunctionExpression(value);
    if (defined) skippedDefault?.(pattern);
    const defaulted =
      t.isUnaryExpression(value, { operator: "void" }) ||
      (t.isIdentifier(value, { name: "undefined" }) && unboundUndefined);
    if (!defined) {
      if (!predicate(pattern.right, child("right"))) return false;
      if (!effectFreeDefault(pattern.right, effects.lexicalRead))
        effects.version++;
    }
    if (
      !defined &&
      !defaulted &&
      (t.isArrayPattern(pattern.left) || t.isObjectPattern(pattern.left))
    ) {
      // Neither receiver is selected. An exact receipt on one cannot authorize
      // the other's operations, or prove that a nested default is skipped.
      if (environment.requireReplaySafety) return false;
      effects.version++;
      return visit(pattern.left, "left", null);
    }
    return visit(pattern.left, "left", defaulted ? pattern.right : value);
  }

  const allowsAbsence = (member: string | null) =>
    allowsPrototypeAbsence(environment, member);
  const select = (member: string | null, inertOwnRead = false) => {
    const selected = selectPatternValue(
      effects.version === version ? value : null,
      member,
      allowsAbsence(member),
      (effects.firstSpreads ??= new Map())
    );
    // An unknown Get (including a getter) may invalidate later literal reads.
    if (selected === null && !inertOwnRead) effects.version++;
    return selected;
  };
  if (t.isObjectPattern(pattern)) {
    if (
      environment.requireReplaySafety &&
      (t.isNullLiteral(value) ||
        t.isUnaryExpression(value, { operator: "void" }) ||
        (unboundUndefined && t.isIdentifier(value, { name: "undefined" })))
    )
      return false;
    if (
      environment.requireReplaySafety &&
      pattern.properties.length === 0 &&
      !(
        t.isObjectExpression(value) ||
        t.isArrayExpression(value) ||
        t.isFunctionExpression(value) ||
        t.isArrowFunctionExpression(value) ||
        (t.isLiteral(value) && !t.isNullLiteral(value))
      )
    )
      return false;
    return pattern.properties.every((property, index) => {
      const key = `properties.${index}`;
      if (t.isRestElement(property)) {
        if (
          environment.requireReplaySafety &&
          !(effects.version === version && value && hasOnlyOwnData(value)) &&
          !(value && environment.canReplayOwnRead?.(value, { kind: "rest" }))
        )
          return false;
        effects.version++; // CopyDataProperties may invoke getters.
        return visit(property.argument, `${key}.argument`);
      }
      if (property.computed) {
        if (
          !t.isExpression(property.key) ||
          !predicate(property.key, child(`${key}.key`))
        )
          return false;
        // The key's normal result being primitive is not enough. Its read and
        // evaluation must preserve the earlier own-read/absence evidence.
        const inertKey = primitiveWithoutEffects(
          property.key,
          effects.primitiveKey
        );
        if (environment.requireReplaySafety && !inertKey) return false;
        if (!inertKey) effects.version++;
      }
      const member = staticMemberName(property);
      const inertOwnRead = freshRootOwnRead && effects.version === version;
      const selectedValue = select(member, inertOwnRead);
      if (
        environment.requireReplaySafety &&
        selectedValue === null &&
        !inertOwnRead &&
        !(
          value &&
          environment.canReplayOwnRead?.(value, { kind: "get", key: member })
        )
      )
        return false;
      return visit(property.value, `${key}.value`, selectedValue);
    });
  }
  if (t.isArrayPattern(pattern)) {
    const indexed =
      environment.nativeArrayIteration && t.isArrayExpression(value);
    if (
      environment.requireReplaySafety &&
      (!environment.nativeArrayIteration ||
        (!indexed && !(value && environment.canReplayIteration?.(value))))
    )
      return false;
    // A native realm does not make an arbitrary receiver use Array iteration.
    // Group replay can retain its iterator, but cannot select numeric properties.
    // Unknown iterators include IteratorClose effects even for an empty pattern.
    // This invalidates later sibling selection, independently of replay authority.
    if (!indexed) effects.version++;
    const exactIteration =
      !!value && environment.canReplayIteration?.(value) === true;
    const spread =
      t.isArrayExpression(value) &&
      value.elements.some((element) => t.isSpreadElement(element));
    // Array spread materializes values as own data slots. This says nothing
    // about executing the source iterable or the values selected from it.
    const ownDense =
      indexed && value.elements.every((element) => element !== null);
    const denseReads = () => ownDense && effects.version === version;
    const completed = (index: number) =>
      indexed &&
      !spread &&
      effects.version === version &&
      index >= value.elements.length;
    const read = (index: number): t.Expression | null => {
      // Done is independent of prototype slots, but unknown effects can change length.
      if (completed(index))
        return t.unaryExpression("void", t.numericLiteral(0));
      if (denseReads())
        return selectPatternValue(
          value,
          String(index),
          allowsAbsence(String(index)),
          (effects.firstSpreads ??= new Map())
        );
      return indexed ? select(String(index)) : null;
    };
    for (const [index, element] of pattern.elements.entries()) {
      if (t.isRestElement(element)) {
        if (denseReads()) {
          // Drain consumes only own data slots; the dynamic length/value stays unknown.
        } else if (indexed && !spread && effects.version === version) {
          for (let rest = index; rest < value.elements.length; rest++) {
            if (
              read(rest) === null &&
              environment.requireReplaySafety &&
              !exactIteration
            )
              return false;
          }
        } else {
          effects.version++;
          if (environment.requireReplaySafety && !exactIteration) return false;
        }
        if (!visit(element.argument, `elements.${index}.argument`))
          return false;
        continue;
      }
      // Elisions advance the iterator too: a discarded value can still Get a getter.
      const ownDataRead = denseReads();
      const selectedValue = read(index);
      if (
        selectedValue === null &&
        environment.requireReplaySafety &&
        !completed(index) &&
        !ownDataRead &&
        !exactIteration
      )
        return false;
      if (element && !visit(element, `elements.${index}`, selectedValue))
        return false;
    }
    return true;
  }
  if (t.isRestElement(pattern)) return visit(pattern.argument, "argument");
  if (t.isIdentifier(pattern) && effects.bindingMayInvokeSetter) {
    effects.version++;
    return environment.requireReplaySafety !== true;
  }
  return true;
}

function allowsPrototypeAbsence(
  environment: PatternSelectionEnvironment,
  member: string | null
): boolean {
  return environment.prototypeMutationKeys !== undefined
    ? member !== null &&
        Array.isArray(environment.prototypeMutationKeys) &&
        !environment.prototypeMutationKeys.includes(member)
    : environment.standardPrototypeAbsence === true;
}

// Standard source-realm members, not reflection on the compiler's own realm.
const standardObjectPrototypeNames = new Set([
  "constructor",
  "toString",
  "toLocaleString",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "__proto__",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__"
]);

function selectPatternValue(
  value: t.Expression | null | undefined,
  member: string | null,
  standardPrototypeAbsence: boolean,
  firstSpreads: Map<t.ArrayExpression, number>
): t.Expression | null {
  if (!value || member === null) return null;
  if (t.isArrayExpression(value)) {
    // Raw AST offsets are indices only before the first spread, and only for
    // canonical index spellings. Do not delegate these checks after lookup.
    if (!isCanonicalArrayIndex(member)) return null;
    const index = Number(member);
    let firstSpread = firstSpreads.get(value);
    if (firstSpread === undefined) {
      const offset = value.elements.findIndex((element) =>
        t.isSpreadElement(element)
      );
      firstSpread = offset < 0 ? Infinity : offset;
      firstSpreads.set(value, firstSpread);
    }
    if (index >= firstSpread) return null;
    const element = value.elements[index];
    if (t.isExpression(element)) return element;
    if (standardPrototypeAbsence)
      return t.unaryExpression("void", t.numericLiteral(0));
  }
  const property = t.isObjectExpression(value)
    ? selectObjectLiteralMember(value, member)
    : undefined;
  if (
    property?.kind === "property" &&
    t.isObjectProperty(property.property) &&
    t.isExpression(property.property.value)
  )
    return property.property.value;

  // A missing own slot can still read an inherited value. Neither the host
  // compiler's Object.prototype nor a hole in the AST proves source absence.
  // Explicit null prototypes need no realm proof; ordinary objects require
  // the separately supplied standard-prototype absence operation contract.
  const missing =
    (property?.kind === "prototype" && t.isNullLiteral(property.value)) ||
    (property?.kind === "missing" &&
      standardPrototypeAbsence &&
      !standardObjectPrototypeNames.has(member));
  return missing ? t.unaryExpression("void", t.numericLiteral(0)) : null;
}

function hasOnlyOwnData(value: t.Expression): boolean {
  if (t.isArrayExpression(value))
    return value.elements.every((element) => !t.isSpreadElement(element));
  if (!t.isObjectExpression(value)) return t.isLiteral(value);
  return value.properties.every((property) =>
    t.isSpreadElement(property)
      ? hasOnlyOwnData(property.argument)
      : (t.isObjectProperty(property) ||
          t.isObjectMethod(property, { kind: "method" })) &&
        staticObjectMemberName(property) !== null
  );
}

function primitiveWithoutEffects(
  node: t.Node,
  lexical?: (node: t.Identifier) => boolean
): boolean {
  if (t.isExpression(node)) node = unwrapTransparentCssRuleExpression(node);
  return (
    t.isStringLiteral(node) ||
    t.isNumericLiteral(node) ||
    t.isBooleanLiteral(node) ||
    t.isNullLiteral(node) ||
    t.isBigIntLiteral(node) ||
    (t.isIdentifier(node) && lexical?.(node) === true) ||
    (t.isUnaryExpression(node) &&
      ["void", "!", "+", "-", "~", "typeof"].includes(node.operator) &&
      primitiveWithoutEffects(node.argument, lexical)) ||
    (t.isBinaryExpression(node) &&
      !["|>", "in", "instanceof"].includes(node.operator) &&
      primitiveWithoutEffects(node.left, lexical) &&
      primitiveWithoutEffects(node.right, lexical)) ||
    (t.isTemplateLiteral(node) &&
      node.expressions.every((expression) =>
        primitiveWithoutEffects(expression, lexical)
      ))
  );
}

function effectFreeDefault(
  node: t.Node,
  lexicalRead?: (node: t.Identifier) => boolean
): boolean {
  if (
    primitiveWithoutEffects(node) ||
    (t.isIdentifier(node) && lexicalRead?.(node) === true) ||
    t.isFunctionExpression(node) ||
    t.isArrowFunctionExpression(node)
  )
    return true;
  if (t.isArrayExpression(node))
    return node.elements.every(
      (element) => !element || effectFreeDefault(element, lexicalRead)
    );
  return (
    t.isObjectExpression(node) &&
    node.properties.every(
      (property) =>
        (t.isObjectProperty(property) || t.isObjectMethod(property)) &&
        (!property.computed || primitiveWithoutEffects(property.key)) &&
        (t.isObjectMethod(property) ||
          effectFreeDefault(property.value, lexicalRead))
    )
  );
}

/** Exact-node receipts from the same fresh-literal selection used above. */
export function collectSkippedPatternDefaults(
  program: NodePath<t.Program>,
  observedEnvironment?: PatternSelectionEnvironment
): ReadonlySet<t.AssignmentPattern> {
  const skipped = new Set<t.AssignmentPattern>();
  const local = localObservation(program, observedEnvironment);
  const environment = combinePatternEnvironment(observedEnvironment, local);
  program.traverse({
    VariableDeclarator(declaration) {
      everyPatternNodeExpression(
        declaration.node.id,
        () => true,
        declaration.node.init,
        hasGlobalUndefined(declaration, local),
        "",
        (pattern) => skipped.add(pattern),
        environment,
        {
          version: 0,
          bindingMayInvokeSetter: hasInterceptableVarBinding(declaration),
          lexicalRead: lexicalDefaultRead(declaration, local),
          primitiveKey: lexicalPrimitiveKey(
            declaration,
            local,
            environment.canReadPrimitiveImport
          )
        }
      );
    }
  });
  return skipped;
}
