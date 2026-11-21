import { types as t, type NodePath } from "@babel/core";
import { isSupportedImportInterop } from "./interop.js";
import { commonJsDataPublications } from "./modules.js";
import type { Binding } from "@babel/traverse";
import { getStaticCssEvalLiteralRequireImportPath } from "../staticCssEval/cjsBindings.js";
import {
  isProvablyUnexecuted,
  buildEvaluationOwner
} from "../extractionCalls/evaluation.js";
import type { PreparedExtractCalls } from "../extractionCalls/types.js";
import type { ProgramScope } from "../types.js";
import { isExtractedReference } from "../transforms/extractionBindings.js";

export interface ModuleReference {
  source: string;
  kind: "import" | "require";
  members: readonly (string | null)[];
  unsafe?: string;
  interop?: boolean | "node";
}

export function staticMemberName(
  node: t.MemberExpression | t.ObjectProperty
): string | null {
  const key = t.isMemberExpression(node) ? node.property : node.key;
  if (!node.computed && t.isIdentifier(key)) return key.name;

  return t.isStringLiteral(key) || t.isNumericLiteral(key)
    ? String(key.value)
    : null;
}

function patternMemberPath(
  pattern: t.Node,
  name: string
): (string | null)[] | undefined {
  if (t.isIdentifier(pattern)) return pattern.name === name ? [] : undefined;
  if (t.isAssignmentPattern(pattern))
    return patternMemberPath(pattern.left, name);
  if (!t.isObjectPattern(pattern)) return undefined;

  for (const property of pattern.properties) {
    if (!t.isObjectProperty(property)) continue;

    const path = patternMemberPath(property.value, name);
    if (path) return [staticMemberName(property), ...path];
  }

  return undefined;
}

function overlapsMemberPath(
  target: readonly string[],
  members: readonly (string | null)[]
): boolean {
  return members.every(
    (member, index) =>
      index >= target.length || member === null || member === target[index]
  );
}

function isTruthinessRead(path: NodePath<t.Node>): boolean {
  const parent = path.parentPath;
  if (!parent) return false;

  if (parent.isUnaryExpression({ operator: "!" })) return true;
  if (
    (parent.isIfStatement() ||
      parent.isWhileStatement() ||
      parent.isDoWhileStatement() ||
      parent.isForStatement() ||
      parent.isConditionalExpression()) &&
    parent.node.test === path.node
  )
    return true;
  if (parent.isLogicalExpression())
    return (
      (parent.node.operator === "&&" && parent.node.left === path.node) ||
      isTruthinessRead(parent)
    );

  return false;
}

function isAttachedToProgram(path: NodePath<t.Node>): boolean {
  let current = path;

  while (!current.isProgram()) {
    const parent = current.parentPath;
    if (
      current.removed ||
      !parent?.node ||
      !t.VISITOR_KEYS[parent.node.type]?.some((key) => {
        const value = (parent.node as unknown as Record<string, unknown>)[key];

        return Array.isArray(value)
          ? value.includes(current.node)
          : value === current.node;
      })
    )
      return false;

    current = parent;
  }

  return true;
}

type NamespaceVisits = Map<Binding, Map<string, number>>;
type MemberTrackingRole = "method" | "value" | "unknown" | "contents";

/** The obligation raised by a tracked reference, not just its syntax. */
export type ExtractionReferenceRole =
  "callee" | "consumer" | "invocation" | "build";
type NamespaceProof = {
  ownDataPaths: ReadonlySet<string>;
  readablePaths: ReadonlySet<string>;
  closedPaths: ReadonlySet<string>;
  immutable?: boolean;
  inertCalls?: ReadonlySet<string>;
  inertConstructions?: ReadonlySet<string>;
  /** Selected API projections only; no descriptor, write or inert-read fact. */
  selectedReads?: ReadonlySet<string>;
};

const namespaceProofFingerprints = new WeakMap<NamespaceProof, string>();

function namespaceProofFingerprint(proof: NamespaceProof): string {
  let fingerprint = namespaceProofFingerprints.get(proof);
  if (fingerprint === undefined) {
    // Proofs publish completed sets; projections and wrappers create new sets.
    // Reuse only these immutable facts, never reference or mutation verdicts.
    fingerprint = JSON.stringify([
      [...proof.ownDataPaths].sort(),
      [...proof.readablePaths].sort(),
      [...proof.closedPaths].sort(),
      proof.immutable,
      [...(proof.inertCalls ?? [])].sort(),
      [...(proof.inertConstructions ?? [])].sort(),
      ...(proof.selectedReads ? [[...proof.selectedReads].sort()] : [])
    ]);
    namespaceProofFingerprints.set(proof, fingerprint);
  }
  return fingerprint;
}

type ExportOriginMetadata = NonNullable<
  PreparedExtractCalls["exportOrigins"]
>[string];
type NamespaceCertificates = {
  modules: WeakMap<ExportOriginMetadata, Map<boolean, NamespaceProof>>;
  projections: WeakMap<NamespaceProof, Map<string, NamespaceProof>>;
};

// Only immutable descriptor facts are shared. AST mutation verdicts and the
// structural keys used by namespace recursion remain local to each check.
const namespaceCertificates = new WeakMap<
  ProgramScope["minchoData"],
  NamespaceCertificates
>();

function getNamespaceCertificates(
  program: ProgramScope
): NamespaceCertificates | undefined {
  if (!program.minchoData) return undefined;
  let certificates = namespaceCertificates.get(program.minchoData);
  if (!certificates) {
    certificates = { modules: new WeakMap(), projections: new WeakMap() };
    namespaceCertificates.set(program.minchoData, certificates);
  }
  return certificates;
}

function projectProof(
  proof: NamespaceProof | undefined,
  members: readonly (string | null)[]
): NamespaceProof | undefined {
  if (!proof || members.some((member) => member === null)) return undefined;
  const project = (paths: ReadonlySet<string>) =>
    new Set(
      [...paths].flatMap((encoded) => {
        const path = JSON.parse(encoded) as string[];
        return members.every((member, index) => path[index] === member)
          ? [JSON.stringify(path.slice(members.length))]
          : [];
      })
    );
  return {
    ownDataPaths: project(proof.ownDataPaths),
    readablePaths: project(proof.readablePaths),
    closedPaths: project(proof.closedPaths),
    immutable: proof.immutable,
    inertCalls: project(proof.inertCalls ?? new Set()),
    inertConstructions: project(proof.inertConstructions ?? new Set()),
    ...(proof.selectedReads
      ? { selectedReads: project(proof.selectedReads) }
      : {})
  };
}

function provenRead(
  proof: NamespaceProof | undefined,
  members: readonly (string | null)[]
): boolean {
  return members.every(
    (member, index) =>
      member !== null &&
      proof?.readablePaths.has(JSON.stringify(members.slice(0, index + 1)))
  );
}

function selectedApiRead(
  proof: NamespaceProof | undefined,
  members: readonly (string | null)[]
): boolean {
  return Boolean(
    proof?.selectedReads &&
    [...proof.selectedReads].some((encoded) => {
      const selected = JSON.parse(encoded) as string[];
      return members.every((member, index) => selected[index] === member);
    })
  );
}

/** Destructuring evaluates reads even when no identifier receives the value. */
function provenPatternReads(
  pattern: t.Node,
  proof: NamespaceProof | undefined,
  members: readonly string[] = [],
  capturedRead?: (value: t.Node) => boolean
): boolean {
  if (t.isIdentifier(pattern)) return true;
  if (t.isAssignmentPattern(pattern))
    return provenPatternReads(pattern.left, proof, members, capturedRead);
  // A property-shape certificate does not prove an iterator implementation.
  if (!t.isObjectPattern(pattern)) return false;

  return pattern.properties.every((property) => {
    if (t.isRestElement(property))
      return proof?.closedPaths.has(JSON.stringify(members)) === true;

    const member = staticMemberName(property);
    if (member === null) return false;
    const selected = [...members, member];
    return (
      (provenRead(proof, selected) ||
        selectedApiRead(proof, selected) ||
        capturedRead?.(property.value)) &&
      provenPatternReads(property.value, proof, selected, capturedRead)
    );
  });
}

function opaqueProof(
  proof: NamespaceProof | undefined
): NamespaceProof | undefined {
  return (
    proof && {
      ownDataPaths: new Set(),
      readablePaths: new Set(),
      closedPaths: new Set(),
      immutable: proof.immutable
    }
  );
}

function wrappedProof(
  proof: NamespaceProof | undefined,
  property: string
): NamespaceProof | undefined {
  if (!proof) return undefined;
  const prefix = (paths: ReadonlySet<string>) =>
    new Set(
      [...paths].map((path) => JSON.stringify([property, ...JSON.parse(path)]))
    );
  return {
    ownDataPaths: new Set([
      JSON.stringify([property]),
      ...prefix(proof.ownDataPaths)
    ]),
    readablePaths: new Set([
      JSON.stringify([property]),
      ...prefix(proof.readablePaths)
    ]),
    closedPaths: new Set(["[]", ...prefix(proof.closedPaths)]),
    immutable: proof.immutable,
    inertCalls: prefix(proof.inertCalls ?? new Set()),
    inertConstructions: prefix(proof.inertConstructions ?? new Set()),
    ...(proof.selectedReads
      ? { selectedReads: prefix(proof.selectedReads) }
      : {})
  };
}

function trackedOwnerMembers(
  members: readonly string[],
  role: MemberTrackingRole
): readonly string[] {
  return role === "method" ? members.slice(0, -1) : members;
}

function namespaceMutation(
  binding: Binding,
  seen: NamespaceVisits = new Map(),
  trackedMembers?: readonly string[],
  memberWritesOnly = false,
  isRegisteredCall?: (
    callee: NodePath<t.Node>,
    role?: ExtractionReferenceRole
  ) => boolean,
  independentDepth = 0,
  role: MemberTrackingRole = "method",
  proof?: NamespaceProof
): string | undefined {
  const context = JSON.stringify([trackedMembers, memberWritesOnly, role]);
  const key = `${context.slice(0, -1)},${proof ? namespaceProofFingerprint(proof) : "null"}]`;
  const visits = seen.get(binding) ?? new Map<string, number>();
  const previousDepth = visits.get(key);
  if (previousDepth !== undefined && previousDepth <= independentDepth)
    return undefined;

  // A shallower shared path must still be checked after a deeper copy path.
  visits.set(key, independentDepth);
  seen.set(binding, visits);

  if (
    !binding.constant &&
    (proof?.immutable || (!memberWritesOnly && independentDepth === 0))
  )
    return `Reassigned binding ${binding.identifier.name}`;

  return namespaceReferencesMutation(
    binding.identifier.name,
    binding.referencePaths,
    seen,
    trackedMembers,
    memberWritesOnly,
    isRegisteredCall,
    independentDepth,
    role,
    proof
  );
}

/** Internal allocation-shape proof; unsupported uses conservatively escape. */
export function hasLocalValueMutation(
  binding: Binding,
  ownDataPaths: ReadonlySet<string>,
  closedDataPaths: ReadonlySet<string> = new Set(["[]"])
): boolean {
  return (
    namespaceMutation(binding, new Map(), [], false, undefined, 0, "value", {
      ownDataPaths,
      readablePaths: ownDataPaths,
      closedPaths: closedDataPaths,
      immutable: true
    }) !== undefined
  );
}

function namespaceReferencesMutation(
  namespaceName: string,
  references: readonly NodePath<t.Node>[],
  seen: NamespaceVisits,
  trackedMembers?: readonly string[],
  memberWritesOnly = false,
  isRegisteredCall?: (
    callee: NodePath<t.Node>,
    role?: ExtractionReferenceRole
  ) => boolean,
  independentDepth = 0,
  role: MemberTrackingRole = "method",
  proof?: NamespaceProof
): string | undefined {
  let publications: ReadonlySet<t.Node> | undefined;
  for (const reference of references) {
    const container = reference.parentPath;
    // Replacing an extracted call can detach an ancestor while leaving the
    // reference itself connected to its former member expression.
    if (!container || !isAttachedToProgram(reference)) continue;
    if (trackedMembers && reference.findParent((path) => path.isTSType()))
      continue;
    if (isProvablyUnexecuted(reference)) continue;
    // Publishing a live export binding does not eagerly consume its value.
    // Other references still undergo the same mutation and escape checks.
    if (
      reference.isExportNamedDeclaration() ||
      (container.isExportSpecifier() &&
        container.node.local === reference.node) ||
      (container.isExportDefaultDeclaration() &&
        container.node.declaration === reference.node)
    )
      continue;
    if (
      container.isAssignmentExpression({ operator: "=" }) &&
      container.node.right === reference.node
    ) {
      const program = reference.scope.getProgramParent().path;
      if (program.isProgram()) {
        publications ??= commonJsDataPublications(program);
        if (publications.has(reference.node)) continue;
      }
    }

    let parent: NodePath<t.Node> | null = container;
    let value: NodePath<t.Node> = reference;
    const members: (string | null)[] = [];
    let writesOnly = memberWritesOnly;

    if (
      trackedMembers ||
      ((parent.isMemberExpression() || parent.isJSXMemberExpression()) &&
        parent.node.object === reference.node)
    ) {
      while (value.parentPath) {
        const next = value.parentPath;
        const member =
          (next.isMemberExpression() || next.isJSXMemberExpression()) &&
          next.node.object === value.node;
        const wrapper =
          trackedMembers &&
          (next.isTSAsExpression() ||
            next.isTSTypeAssertion() ||
            next.isTSNonNullExpression() ||
            next.isTSSatisfiesExpression() ||
            next.isParenthesizedExpression()) &&
          next.node.expression === value.node;
        const sequence =
          trackedMembers &&
          next.isSequenceExpression() &&
          next.node.expressions[next.node.expressions.length - 1] ===
            value.node &&
          next.node.expressions
            .slice(0, -1)
            .every((expression) =>
              t.isNumericLiteral(expression, { value: 0 })
            );

        if (!member && !wrapper && !sequence) break;
        if (next.isMemberExpression())
          members.push(staticMemberName(next.node));
        else if (next.isJSXMemberExpression())
          members.push(next.node.property.name);

        value = next;
      }

      if (isWriteTarget(value)) {
        if (proof?.immutable)
          return `Mutated CommonJS namespace ${namespaceName}`;
        // Reassigning a value or replacing a fresh container's own slot does
        // not mutate the shared value retained below it.
        if (
          (writesOnly && members.length === 0) ||
          (independentDepth > 0 &&
            members.length === independentDepth &&
            value.parentPath?.isAssignmentExpression({ operator: "=" }) &&
            proof?.ownDataPaths.has(JSON.stringify(members)) &&
            provenRead(proof, members.slice(0, -1)))
        )
          continue;
        // A method can read other fields on its owner through `this`.
        if (
          !trackedMembers ||
          overlapsMemberPath(trackedOwnerMembers(trackedMembers, role), members)
        )
          return `Mutated CommonJS namespace ${namespaceName}`;

        continue;
      }
      if (trackedMembers && !overlapsMemberPath(trackedMembers, members)) {
        if (
          !overlapsMemberPath(
            trackedOwnerMembers(trackedMembers, role),
            members
          )
        )
          continue;

        writesOnly = true;
      }
      if (!trackedMembers) continue;

      parent = value.parentPath;
    }

    const remainingMembers = writesOnly
      ? []
      : trackedMembers?.slice(members.length);
    const remainingDepth = Math.max(0, independentDepth - members.length);
    const remainingProof = projectProof(proof, members);
    // Tracking a method protects its receiver; it does not certify separate
    // consumer reads of that receiver's accessor-capable properties.
    const readIsProven = provenRead(proof, members);
    // Function endpoints can still expose mutable properties through aliases.
    if (remainingMembers?.length === 0) writesOnly = true;
    if (trackedMembers && readIsProven && isTruthinessRead(value)) continue;
    if (
      role === "method" &&
      readIsProven &&
      (parent?.isJSXOpeningElement() || parent?.isJSXClosingElement())
    )
      continue;

    if (parent?.isVariableDeclarator() && parent.node.init === value.node) {
      const declaration = parent;
      const capturedRead = (value: t.Node): boolean => {
        if (!t.isIdentifier(value)) return false;
        const alias = declaration.scope.getBinding(value.name);
        // Moving every consuming invocation preserves the declaration's
        // original reads in the same sidecar. Registration alone says
        // nothing about a getter's effects or when it executes.
        return Boolean(
          alias?.constant &&
          alias.referencePaths.length &&
          alias.referencePaths.every(
            (reference) =>
              isExtractedReference(reference) ||
              (reference.parentPath?.isCallExpression() &&
                reference.parentPath.node.callee === reference.node &&
                isRegisteredCall?.(reference, "consumer"))
          )
        );
      };
      if (
        !readIsProven &&
        !selectedApiRead(proof, members) &&
        !capturedRead(parent.node.id)
      )
        return `Escaped CommonJS namespace ${namespaceName}`;
      if (t.isIdentifier(parent.node.id)) {
        const alias = parent.scope.getBinding(parent.node.id.name);
        const mutation =
          alias &&
          namespaceMutation(
            alias,
            seen,
            remainingMembers,
            writesOnly,
            isRegisteredCall,
            remainingDepth,
            role,
            remainingProof
          );
        if (mutation) return mutation;
      } else if (remainingMembers) {
        if (
          !provenPatternReads(parent.node.id, remainingProof, [], capturedRead)
        )
          return `Escaped CommonJS namespace ${namespaceName}`;

        for (const name of Object.keys(
          t.getBindingIdentifiers(parent.node.id)
        )) {
          const rest = t.isObjectPattern(parent.node.id)
            ? parent.node.id.properties.find(
                (property) =>
                  t.isRestElement(property) &&
                  t.isIdentifier(property.argument, { name })
              )
            : undefined;
          if (rest && t.isObjectPattern(parent.node.id)) {
            if (!remainingProof?.closedPaths.has("[]"))
              return `Escaped CommonJS namespace ${namespaceName}`;
            const excluded = new Set<string>();
            for (const property of parent.node.id.properties) {
              if (t.isRestElement(property)) continue;
              const key = staticMemberName(property);
              if (
                key === null ||
                !t.isIdentifier(property.value) ||
                !provenRead(remainingProof, [key])
              )
                return `Escaped CommonJS namespace ${namespaceName}`;
              excluded.add(key);
            }
            if (remainingMembers.length && excluded.has(remainingMembers[0]))
              continue;
            const retain = (paths: ReadonlySet<string>) =>
              new Set(
                [...paths].filter((path) => !excluded.has(JSON.parse(path)[0]))
              );
            const alias = parent.scope.getBinding(name);
            const mutation =
              alias &&
              namespaceMutation(
                alias,
                seen,
                remainingMembers,
                writesOnly,
                isRegisteredCall,
                Math.max(1, remainingDepth),
                role,
                {
                  ownDataPaths: retain(remainingProof.ownDataPaths),
                  readablePaths: retain(remainingProof.readablePaths),
                  closedPaths: retain(remainingProof.closedPaths),
                  immutable: remainingProof.immutable
                }
              );
            if (mutation) return mutation;
            continue;
          }
          const members = patternMemberPath(parent.node.id, name);
          if (!members) {
            return `Escaped CommonJS namespace ${namespaceName}`;
          }
          const aliasWritesOnly =
            writesOnly || !overlapsMemberPath(remainingMembers, members);
          if (
            !writesOnly &&
            aliasWritesOnly &&
            !overlapsMemberPath(
              trackedOwnerMembers(remainingMembers, role),
              members
            )
          )
            continue;

          const alias = parent.scope.getBinding(name);
          const mutation =
            alias &&
            namespaceMutation(
              alias,
              seen,
              aliasWritesOnly ? [] : remainingMembers.slice(members.length),
              aliasWritesOnly,
              isRegisteredCall,
              Math.max(0, remainingDepth - members.length),
              role,
              projectProof(remainingProof, members)
            );
          if (mutation) return mutation;
        }
      }

      continue;
    }

    if (
      role === "contents" &&
      readIsProven &&
      parent?.isCallExpression() &&
      parent.node.callee === value.node &&
      remainingProof?.inertCalls?.has("[]")
    )
      continue;
    // A constructed value can inherit unknown contents. Only a discarded
    // construction uses the invocation proof without exposing that result.
    if (
      role === "contents" &&
      readIsProven &&
      parent?.isNewExpression() &&
      parent.node.callee === value.node &&
      parent.parentPath.isExpressionStatement() &&
      remainingProof?.inertConstructions?.has("[]")
    )
      continue;
    if (
      parent?.isCallExpression() &&
      parent.node.callee === value.node &&
      (!trackedMembers ||
        isRegisteredCall?.(
          value,
          // Invoking an unknown value/capture can reach the tracked owner
          // without receiving it as an argument. A selected method reference
          // alone does not carry that hidden-owner invocation obligation.
          role === "unknown" || role === "contents" ? "invocation" : "callee"
        ))
    )
      continue;

    // Registered authoring functions may consume sibling values without
    // exposing the preset to an unanalysed runtime function.
    let consumer = value;
    let consumerDepth = remainingDepth;
    let consumerProof = remainingProof;
    let consumerReadIsProven = readIsProven;
    let computedKey = false;
    let discarded = false;
    while (consumer.parentPath) {
      const wrapper = consumer.parentPath;
      if (
        (wrapper.isObjectProperty() &&
          (wrapper.node.value === consumer.node ||
            (wrapper.node.computed && wrapper.node.key === consumer.node)) &&
          wrapper.parentPath.isObjectExpression()) ||
        (wrapper.isSpreadElement() &&
          wrapper.node.argument === consumer.node) ||
        wrapper.isArrayExpression() ||
        (wrapper.isObjectExpression() && consumer.isSpreadElement()) ||
        wrapper.isSequenceExpression() ||
        ((wrapper.isTSAsExpression() ||
          wrapper.isTSTypeAssertion() ||
          wrapper.isTSNonNullExpression() ||
          wrapper.isTSSatisfiesExpression() ||
          wrapper.isParenthesizedExpression()) &&
          wrapper.node.expression === consumer.node)
      ) {
        if (wrapper.isSequenceExpression()) {
          discarded ||= wrapper.node.expressions.at(-1) !== consumer.node;
        } else if (wrapper.isObjectProperty()) {
          if (wrapper.node.key === consumer.node && wrapper.node.computed)
            computedKey = true;
          else {
            consumerDepth++;
            const name = staticMemberName(wrapper.node);
            consumerProof =
              name !== null &&
              name !== "__proto__" &&
              wrapper.parentPath.isObjectExpression() &&
              wrapper.parentPath.node.properties.length === 1
                ? wrappedProof(consumerProof, name)
                : opaqueProof(consumerProof);
          }
        } else if (wrapper.isSpreadElement()) {
          consumerReadIsProven &&= Boolean(
            consumerProof?.closedPaths.has("[]")
          );
          if (
            wrapper.parentPath.isObjectExpression() ||
            wrapper.parentPath.isArrayExpression()
          )
            // Repeated shallow copies do not copy another level of values.
            consumerDepth = Math.max(1, consumerDepth);
        } else if (wrapper.isArrayExpression() && !consumer.isSpreadElement()) {
          consumerDepth++;
          const index = typeof consumer.key === "number" ? consumer.key : null;
          consumerProof =
            index !== null &&
            !wrapper.node.elements
              .slice(0, index)
              .some((element) => t.isSpreadElement(element))
              ? wrappedProof(consumerProof, String(index))
              : opaqueProof(consumerProof);
          if (consumerProof)
            consumerProof = {
              ...consumerProof,
              // A known array index does not certify its iterator/prototype.
              closedPaths: new Set(
                [...consumerProof.closedPaths].filter((path) => path !== "[]")
              )
            };
        } else if (
          wrapper.isObjectExpression() &&
          wrapper.node.properties.length !== 1
        )
          consumerProof = opaqueProof(consumerProof);
        consumer = wrapper.isObjectProperty() ? wrapper.parentPath : wrapper;
      } else break;
    }
    const consumerCall = consumer.parentPath;
    if (
      trackedMembers &&
      !computedKey &&
      !discarded &&
      consumer !== value &&
      consumerCall?.isVariableDeclarator() &&
      consumerCall.node.init === consumer.node &&
      t.isIdentifier(consumerCall.node.id)
    ) {
      if (!consumerReadIsProven)
        return `Escaped CommonJS namespace ${namespaceName}`;
      const alias = consumerCall.scope.getBinding(consumerCall.node.id.name);
      const mutation =
        alias &&
        namespaceMutation(
          alias,
          seen,
          [],
          false,
          isRegisteredCall,
          consumerDepth,
          role,
          consumerProof
        );
      if (mutation) return mutation;
      if (alias) continue;
    }
    if (
      trackedMembers &&
      consumerCall?.isCallExpression() &&
      consumer.listKey === "arguments" &&
      isRegisteredCall?.(
        consumerCall.get("callee") as NodePath<t.Node>,
        "consumer"
      )
    )
      continue;

    // Reading typeof does not expose the module object to another function.
    if (readIsProven && parent?.isUnaryExpression({ operator: "typeof" }))
      continue;

    // JSX lowering can wrap an already-safe className read in its own cx call.
    // Keep that read safe without trusting user calls to the same runtime API.
    let classNameParent = parent;
    if (
      role === "method" &&
      writesOnly &&
      parent?.isCallExpression() &&
      parent.node.arguments.some((argument) => argument === value.node)
    ) {
      const callee = parent.get("callee");
      const program = parent.scope.getProgramParent() as ProgramScope;
      const generatedCx = program.minchoData?.imports?.get(
        "@mincho-js/css/classname:cx"
      );

      if (generatedCx && callee.isIdentifier({ name: generatedCx.name })) {
        const binding = callee.scope.getBinding(generatedCx.name);

        if (binding && binding === program.getBinding(generatedCx.name))
          classNameParent = parent.parentPath;
      }
    }

    // An intrinsic className consumes the copied class string, not its owner.
    if (
      role === "method" &&
      writesOnly &&
      readIsProven &&
      classNameParent?.isJSXExpressionContainer()
    ) {
      const attribute = classNameParent.parentPath;
      const opening = attribute.parentPath;

      if (
        attribute.isJSXAttribute() &&
        t.isJSXIdentifier(attribute.node.name, { name: "className" }) &&
        opening?.isJSXOpeningElement() &&
        t.isJSXIdentifier(opening.node.name) &&
        /^[a-z]/.test(opening.node.name.name)
      )
        continue;
    }

    // A reference captured by a compiler-selected build callback belongs to
    // that whole evaluation. Deferred nested functions have no such owner.
    const buildOwner = buildEvaluationOwner(value);
    if (
      !(parent?.isCallExpression() && parent.node.callee === value.node) &&
      buildOwner &&
      isRegisteredCall?.(buildOwner.get("callee"), "build")
    )
      continue;

    return `Escaped CommonJS namespace ${namespaceName}`;
  }

  return undefined;
}

export function isWriteTarget(path: NodePath<t.Node>): boolean {
  const parent = path.parentPath;
  if (!parent) return false;

  if (
    parent.isAssignmentExpression() ||
    parent.isForInStatement() ||
    parent.isForOfStatement()
  )
    return parent.node.left === path.node;

  if (
    parent.isUpdateExpression() ||
    parent.isUnaryExpression({ operator: "delete" })
  )
    return true;

  if (
    parent.isArrayPattern() ||
    parent.isObjectPattern() ||
    (parent.isObjectProperty() &&
      parent.parentPath.isObjectPattern() &&
      parent.node.value === path.node) ||
    (parent.isAssignmentPattern() && parent.node.left === path.node) ||
    parent.isRestElement() ||
    parent.isTSAsExpression() ||
    parent.isTSNonNullExpression() ||
    parent.isTSTypeAssertion() ||
    parent.isParenthesizedExpression()
  )
    return isWriteTarget(parent);

  return false;
}

/** Resolve the actual binding, including compiler comma calls and local aliases. */
export function getModuleReference(
  path: NodePath<t.Node>,
  seen = new Set<t.Node>()
): ModuleReference | null {
  return resolveModuleReference(path, seen);
}

/** Attribute an observable native runtime use to its lexical module origin.
 * This does not prove namespace integrity and must only retain authored work. */
export function getModuleRuntimeDemandOrigin(
  path: NodePath<t.Node>
): ModuleReference | null {
  return resolveModuleReference(path, new Set(), undefined, undefined, false);
}

/** Primitive plus accessor-free read evidence for one emitted named ESM import.
 * Neither registration nor source identity alone establishes this contract. */
export function isProvenPrimitiveImport(binding: Binding): boolean {
  const specifier = binding.path;
  if (
    !binding.constant ||
    !specifier.isImportSpecifier() ||
    specifier.node.local !== binding.identifier ||
    specifier.node.importKind === "type" ||
    specifier.node.importKind === "typeof" ||
    !specifier.parentPath.isImportDeclaration() ||
    specifier.parentPath.node.importKind === "type" ||
    specifier.parentPath.node.importKind === "typeof"
  )
    return false;
  const name = t.isIdentifier(specifier.node.imported)
    ? specifier.node.imported.name
    : specifier.node.imported.value;
  const config = (binding.scope.getProgramParent() as ProgramScope).minchoData
    ?.extractCalls;
  const id =
    config?.resolvedSources?.import[specifier.parentPath.node.source.value];
  const metadata = id ? config?.exportOrigins?.[id] : undefined;
  const encoded = JSON.stringify([name]);
  return (
    metadata?.primitiveExports?.includes(encoded) === true &&
    metadata.readablePaths?.includes(encoded) === true &&
    ![
      ...(metadata.unknownExports ?? []),
      ...(metadata.unknownContents ?? [])
    ].some((uncertain) => uncertain === "[]" || uncertain === encoded)
  );
}

/** Descriptor evidence only; callers must separately check argument mutations. */
export function isProvenModuleDataRead(path: NodePath<t.Node>): boolean {
  const reference = resolveModuleReference(
    path,
    new Set(),
    undefined,
    undefined,
    false
  );
  if (!reference || reference.unsafe || reference.members.includes(null))
    return false;
  const config = (path.scope.getProgramParent() as ProgramScope).minchoData
    ?.extractCalls;
  const id = config?.resolvedSources?.[reference.kind][reference.source];
  const metadata = id ? config?.exportOrigins?.[id] : undefined;
  if (!metadata) return false;

  const syntheticDefault =
    reference.interop === "node" ||
    (Boolean(reference.interop) && !metadata.esModule);
  const members =
    syntheticDefault && reference.members[0] === "default"
      ? reference.members.slice(1)
      : reference.members;
  const encoded = JSON.stringify(members);
  return (
    metadata.ownDataPaths?.includes(encoded) === true ||
    metadata.closedDataPaths?.includes(encoded) === true
  );
}

/** Check the nested extraction's export path and its ancestor objects. */
export function getExtractionModuleReference(
  path: NodePath<t.Node>,
  isRegisteredCall?: (
    callee: NodePath<t.Node>,
    role?: ExtractionReferenceRole
  ) => boolean
): ModuleReference | null {
  // Resolve binding facts once, then apply the descriptor-aware namespace
  // analysis below. An earlier scan without those proofs loses safe copies.
  const resolved = resolveModuleReference(
    path,
    new Set(),
    undefined,
    undefined,
    false
  );
  if (!resolved || resolved.unsafe) return resolved;
  const members = resolved.members.filter((member) => member !== null);
  if (members.length !== resolved.members.length) return resolved;

  // Separate declarations can still refer to the same module export. Include
  // require bindings in nested scopes because require shares its cached object.
  const program = path.scope.getProgramParent() as ProgramScope;
  const certificates = getNamespaceCertificates(program);
  const sources = program.minchoData?.extractCalls?.resolvedSources;
  const resolvedId = sources?.[resolved.kind][resolved.source];
  const sameModule = (source: string, kind: ModuleReference["kind"]) =>
    // Matching IDs prove aliases, but different import/require entry files
    // cannot prove that the same specifier exports independent receivers.
    source === resolved.source ||
    (resolvedId !== undefined && sources?.[kind][source] === resolvedId);
  const origins = program.minchoData?.extractCalls?.exportOrigins;
  const hasSyntheticDefault = (reference: ModuleReference) => {
    if (!reference.interop) return false;
    if (reference.interop === "node") return true;

    const id = sources?.[reference.kind][reference.source];
    return !id || !origins?.[id]?.esModule;
  };
  const selectedSyntheticDefault = hasSyntheticDefault(resolved);
  const rawMembers =
    selectedSyntheticDefault && members[0] === "default"
      ? members.slice(1)
      : members;
  const selectedOrigins = resolvedId
    ? origins?.[resolvedId]?.exports
    : undefined;
  const receiverOrigins = Object.entries(selectedOrigins ?? {}).flatMap(
    ([encoded, origin]) => {
      const prefix = JSON.parse(encoded) as string[];
      return prefix.every((member, index) => rawMembers[index] === member)
        ? [{ prefix, origin }]
        : [];
    }
  );

  function interopMemberPaths(
    imported: ModuleReference,
    rawPath: string[]
  ): string[][] {
    // Proven identities and uncertain aliases both refer to the raw module.
    // A supported synthetic default exposes that namespace at .default too.
    return hasSyntheticDefault(imported)
      ? [rawPath, ["default", ...rawPath]]
      : [rawPath];
  }

  function moduleProof(imported: ModuleReference): NamespaceProof {
    const id = sources?.[imported.kind][imported.source];
    const metadata = id ? origins?.[id] : undefined;
    const syntheticDefault = hasSyntheticDefault(imported);
    const cached = metadata
      ? certificates?.modules.get(metadata)?.get(syntheticDefault)
      : undefined;
    if (cached) return cached;

    const ownDataPaths = new Set<string>();
    const readablePaths = new Set<string>();
    const closedPaths = new Set<string>();
    const inertCalls = new Set<string>();
    const inertConstructions = new Set<string>();
    const addReadable = (members: readonly string[]) => {
      for (let length = 1; length <= members.length; length++)
        readablePaths.add(JSON.stringify(members.slice(0, length)));
    };

    for (const encoded of metadata?.ownDataPaths ?? [])
      for (const path of interopMemberPaths(imported, JSON.parse(encoded))) {
        ownDataPaths.add(JSON.stringify(path));
        addReadable(path);
      }
    for (const encoded of metadata?.readablePaths ?? [])
      for (const path of interopMemberPaths(imported, JSON.parse(encoded)))
        addReadable(path);

    for (const encoded of metadata?.closedDataPaths ?? [])
      for (const path of interopMemberPaths(imported, JSON.parse(encoded)))
        closedPaths.add(JSON.stringify(path));
    for (const encoded of Object.keys(metadata?.exports ?? {})) {
      const path = JSON.parse(encoded) as string[];
      for (const members of interopMemberPaths(imported, path)) {
        // Resolved export bindings are readable, but they are not a proof of
        // an ordinary writable property on the module namespace.
        addReadable(members);
      }
    }
    for (const [encoded, kind] of Object.entries(
      metadata?.inertInvocations ?? {}
    ))
      for (const path of interopMemberPaths(imported, JSON.parse(encoded)))
        (kind === "call" ? inertCalls : inertConstructions).add(
          JSON.stringify(path)
        );
    const proof: NamespaceProof = {
      ownDataPaths,
      readablePaths,
      closedPaths,
      inertCalls,
      inertConstructions
    };
    if (metadata && certificates) {
      const variants = certificates.modules.get(metadata) ?? new Map();
      variants.set(syntheticDefault, proof);
      certificates.modules.set(metadata, variants);
    }
    return proof;
  }

  function projectedModuleProof(imported: ModuleReference) {
    const proof = moduleProof(imported);
    if (!certificates || imported.members.some((member) => member === null))
      return projectProof(proof, imported.members);
    const key = JSON.stringify(imported.members);
    const projections = certificates.projections.get(proof) ?? new Map();
    let projected = projections.get(key);
    if (!projected) {
      projected = projectProof(proof, imported.members);
      if (projected) projections.set(key, projected);
      certificates.projections.set(proof, projections);
    }
    return projected;
  }

  function selectedReadProof(
    imported: ModuleReference,
    proof: NamespaceProof | undefined,
    projection: readonly (string | null)[]
  ): NamespaceProof | undefined {
    if (!proof || !sameModule(imported.source, imported.kind)) return proof;
    // Keep the established selected-endpoint projection contract when the
    // same path also carries an unknown-alias invocation obligation. This
    // per-query permission is never stored in shared metadata certificates.
    const selectedReads = new Set(
      interopMemberPaths(imported, rawMembers).flatMap((selected) =>
        projection.every((member, index) => selected[index] === member)
          ? [JSON.stringify(selected.slice(projection.length))]
          : []
      )
    );
    return selectedReads.size ? { ...proof, selectedReads } : proof;
  }

  type TrackedMemberPath = {
    members: string[];
    role: MemberTrackingRole;
    independentDepth: number;
  };

  const trackedPaths = new Map<string, TrackedMemberPath[]>();
  function trackedMemberPaths(imported: ModuleReference): TrackedMemberPath[] {
    const key = JSON.stringify([
      imported.kind,
      imported.source,
      imported.interop
    ]);
    const cached = trackedPaths.get(key);
    if (cached) return cached;
    const paths = new Map<string, TrackedMemberPath>();
    const add = (path: TrackedMemberPath) =>
      paths.set(JSON.stringify(path), path);
    const id = sources?.[imported.kind][imported.source];
    const importedOrigins = id ? origins?.[id] : undefined;
    const ownDataPaths = new Set(importedOrigins?.ownDataPaths ?? []);

    const addRawPath = (
      rawPath: string[],
      role: MemberTrackingRole,
      knownContainerPath?: readonly string[]
    ) => {
      let independentDepth = 0;
      if (knownContainerPath && receiverOrigins.length)
        for (const [encoded, origin] of Object.entries(
          importedOrigins?.exports ?? {}
        )) {
          const prefix = JSON.parse(encoded) as string[];
          if (
            !receiverOrigins.some((selected) => selected.origin === origin) &&
            prefix.length < knownContainerPath.length &&
            prefix.every(
              (member, index) => knownContainerPath[index] === member
            ) &&
            ownDataPaths.has(
              JSON.stringify(knownContainerPath.slice(0, prefix.length + 1))
            )
          )
            independentDepth = Math.max(independentDepth, prefix.length + 1);
        }

      // Unknown contents do not erase a proven container identity. Its own
      // slots can be replaced independently; nested values and escapes still
      // need the usual mutation analysis.
      for (const members of interopMemberPaths(imported, rawPath))
        add({
          members,
          role,
          independentDepth: independentDepth
            ? independentDepth + members.length - rawPath.length
            : 0
        });
    };

    if (sameModule(imported.source, imported.kind)) {
      // A direct lookup still observes replacement of its namespace slot.
      // Independent-container evidence applies to translated value aliases.
      add({ members, role: "method", independentDepth: 0 });
      addRawPath(rawMembers, "method");
    }

    for (const { prefix, origin } of receiverOrigins)
      for (const [other, candidate] of Object.entries(
        importedOrigins?.exports ?? {}
      )) {
        if (candidate !== origin) continue;
        const otherMembers = JSON.parse(other) as string[];
        addRawPath(
          [...otherMembers, ...rawMembers.slice(prefix.length)],
          prefix.length === rawMembers.length ? "value" : "method",
          otherMembers
        );
      }

    for (const encoded of importedOrigins?.unknownExports ?? []) {
      const path = JSON.parse(encoded) as string[];
      addRawPath(path, "unknown", path);
    }
    for (const encoded of importedOrigins?.unknownContents ?? []) {
      const path = JSON.parse(encoded) as string[];
      addRawPath(path, "contents", path);
    }
    const result = [...paths.values()];
    trackedPaths.set(key, result);
    return result;
  }

  const bindings = new Set(Object.values(program.bindings));
  const directRequires = new Set<NodePath<t.CallExpression>>();

  // Different import/require entrypoints can re-export the same receiver.
  program.path.traverse({
    CallExpression(call) {
      const source = getStaticCssEvalLiteralRequireImportPath(
        call.node,
        call.scope
      );
      if (!source) return;

      let reference = call;
      // Known interop helpers preserve the module reference. Check the
      // resulting namespace without treating their argument as an escape.
      while (
        reference.parentPath.isCallExpression() &&
        reference.parentPath.node.arguments[0] === reference.node &&
        isSupportedImportInterop(reference.parentPath)
      )
        reference = reference.parentPath;

      // Loading a module without consuming its value exposes no namespace.
      if (!reference.parentPath.isExpressionStatement())
        directRequires.add(reference);
    },
    VariableDeclarator(declaration) {
      for (const name of Object.keys(
        t.getBindingIdentifiers(declaration.node.id)
      )) {
        const binding = declaration.scope.getBinding(name);
        if (binding) bindings.add(binding);
      }
    }
  });

  for (const binding of bindings) {
    const declaration = binding.path;
    const reference =
      declaration.isImportSpecifier() ||
      declaration.isImportDefaultSpecifier() ||
      declaration.isImportNamespaceSpecifier()
        ? declaration.get("local")
        : declaration.isVariableDeclarator()
          ? binding.referencePaths.find(isAttachedToProgram)
          : undefined;
    if (!reference || Array.isArray(reference)) continue;

    const imported = getModuleReference(reference);
    if (!imported) continue;
    const targets = trackedMemberPaths(imported).filter(
      ({ members: target, role }) => {
        // Flat ESM exports do not share a receiver with sibling exports.
        // Keep the endpoint and the namespace that can reach it protected.
        const receiver =
          resolved.kind === "import" && target.length === 1
            ? target
            : trackedOwnerMembers(target, role);
        return overlapsMemberPath(receiver, imported.members);
      }
    );
    if (targets.length === 0) continue;

    // Descriptor facts are needed only for values that can reach this receiver.
    // Unrelated theme exports can contain thousands of paths.
    const proof = selectedReadProof(
      imported,
      projectedModuleProof(imported),
      imported.members
    );

    for (const { members: target, role, independentDepth } of targets) {
      const memberWritesOnly =
        !overlapsMemberPath(target, imported.members) ||
        imported.members.length >= target.length;
      const unsafe = namespaceMutation(
        binding,
        new Map(),
        memberWritesOnly ? [] : target.slice(imported.members.length),
        memberWritesOnly,
        isRegisteredCall,
        Math.max(0, independentDepth - imported.members.length),
        role,
        proof
      );

      if (unsafe) return { ...resolved, unsafe };
    }
  }

  for (const reference of directRequires) {
    const imported = getModuleReference(reference);
    if (!imported) continue;
    const targets = trackedMemberPaths(imported);
    if (targets.length === 0) continue;
    const proof = selectedReadProof(imported, moduleProof(imported), []);

    for (const { members: target, role, independentDepth } of targets) {
      const unsafe = namespaceReferencesMutation(
        resolved.source,
        [reference],
        new Map(),
        target,
        false,
        isRegisteredCall,
        independentDepth,
        role,
        proof
      );
      if (unsafe) return { ...resolved, unsafe };
    }
  }

  return resolved;
}

function resolveModuleReference(
  path: NodePath<t.Node>,
  seen: Set<t.Node>,
  trackedMembers?: readonly string[],
  isRegisteredCall?: (
    callee: NodePath<t.Node>,
    role?: ExtractionReferenceRole
  ) => boolean,
  checkNamespace = true
): ModuleReference | null {
  if (seen.has(path.node)) return null;

  const next = new Set(seen).add(path.node);
  if (
    path.isTSAsExpression() ||
    path.isTSTypeAssertion() ||
    path.isTSNonNullExpression() ||
    path.isTSSatisfiesExpression() ||
    path.isParenthesizedExpression()
  )
    return resolveModuleReference(
      path.get("expression") as NodePath<t.Node>,
      next,
      trackedMembers,
      isRegisteredCall,
      checkNamespace
    );

  if (path.isSequenceExpression()) {
    const expressions = path.get("expressions");
    if (
      expressions
        .slice(0, -1)
        .every((item) => item.isNumericLiteral({ value: 0 }))
    )
      return resolveModuleReference(
        expressions[expressions.length - 1]!,
        next,
        trackedMembers,
        isRegisteredCall,
        checkNamespace
      );

    return null;
  }

  if (path.isCallExpression()) {
    const source = getStaticCssEvalLiteralRequireImportPath(
      path.node,
      path.scope
    );
    if (source) return { source, kind: "require", members: [] };

    const argument = path.get("arguments")[0];
    const wrapped = argument?.isExpression()
      ? resolveModuleReference(
          argument,
          next,
          trackedMembers,
          isRegisteredCall,
          checkNamespace
        )
      : null;
    if (wrapped?.kind === "require" && wrapped.members.length === 0)
      return {
        ...wrapped,
        interop: t.isNumericLiteral(path.node.arguments[1], { value: 1 })
          ? "node"
          : true,
        ...(isSupportedImportInterop(path)
          ? {}
          : { unsafe: "Unsupported CommonJS interop helper" })
      };

    return null;
  }

  if (path.isMemberExpression() || path.isJSXMemberExpression()) {
    const reference = resolveModuleReference(
      path.get("object") as NodePath<t.Node>,
      next,
      trackedMembers,
      isRegisteredCall,
      checkNamespace
    );
    if (!reference) return null;

    const member = t.isJSXMemberExpression(path.node)
      ? path.node.property.name
      : staticMemberName(path.node);

    return {
      ...reference,
      members: [...reference.members, member],
      ...(member === null ? { unsafe: "Dynamic CommonJS member access" } : {})
    };
  }

  if (!path.isIdentifier() && !path.isJSXIdentifier()) return null;

  const binding = path.scope.getBinding(path.node.name);
  if (!binding) return null;

  const declaration = binding.path;

  if (
    declaration.isImportSpecifier() ||
    declaration.isImportDefaultSpecifier() ||
    declaration.isImportNamespaceSpecifier()
  ) {
    const parent = declaration.parentPath;
    if (!parent.isImportDeclaration() || parent.node.importKind === "type")
      return null;

    const members = declaration.isImportNamespaceSpecifier()
      ? []
      : [
          declaration.isImportDefaultSpecifier()
            ? "default"
            : t.isIdentifier(declaration.node.imported)
              ? declaration.node.imported.name
              : declaration.node.imported.value
        ];
    const unsafe =
      checkNamespace && trackedMembers
        ? namespaceMutation(
            binding,
            new Map(),
            trackedMembers.slice(members.length),
            false,
            isRegisteredCall
          )
        : undefined;

    return {
      source: parent.node.source.value,
      kind: "import",
      members,
      ...(unsafe ? { unsafe } : {})
    };
  }

  if (!declaration.isVariableDeclarator()) return null;

  // Array destructuring consumes iterator elements, not module exports.
  if (
    !t.isIdentifier(declaration.node.id) &&
    !t.isObjectPattern(declaration.node.id)
  )
    return null;

  const init = declaration.get("init");
  if (!init.node) return null;

  let reference = resolveModuleReference(
    init as NodePath<t.Node>,
    next,
    trackedMembers,
    isRegisteredCall,
    checkNamespace
  );
  if (!reference) return null;

  if (t.isObjectPattern(declaration.node.id)) {
    const property = declaration.node.id.properties.find(
      (item) =>
        t.isObjectProperty(item) &&
        t.isIdentifier(item.value, { name: path.node.name })
    );
    if (!property || !t.isObjectProperty(property)) return null;

    reference = {
      ...reference,
      members: [...reference.members, staticMemberName(property)]
    };
  }

  let unsafe = reference.unsafe;

  if (!binding.constant) unsafe = `Reassigned binding ${path.node.name}`;
  if (
    reference.kind === "require" &&
    path.node.start != null &&
    declaration.node.end != null &&
    path.node.start < declaration.node.end &&
    path.getFunctionParent() === declaration.getFunctionParent()
  )
    unsafe ??= `CommonJS binding ${path.node.name} used before initialization`;
  if (checkNamespace && trackedMembers)
    unsafe ??= namespaceMutation(
      binding,
      new Map(),
      trackedMembers.slice(reference.members.length),
      false,
      isRegisteredCall
    );
  else if (
    checkNamespace &&
    reference.kind === "require" &&
    reference.members.length === 0
  )
    unsafe ??= namespaceMutation(binding);

  return { ...reference, ...(unsafe ? { unsafe } : {}) };
}

export function referencesModuleExport(
  path: NodePath<t.Node>,
  source: string,
  name: string,
  strict = false
): boolean {
  return referencesModuleExports(path, { [source]: [name] }, strict);
}

/** Resolve namespace safety once when matching a collection of API exports. */
export function referencesModuleExports(
  path: NodePath<t.Node>,
  sources: Readonly<Record<string, readonly string[]>>,
  strict = false
): boolean {
  for (const [source, names] of Object.entries(sources))
    if (names.some((name) => path.referencesImport(source, name))) return true;

  const reference = getModuleReference(path);
  if (!reference || !Object.hasOwn(sources, reference.source)) return false;

  const names = sources[reference.source];
  if (!names?.length) return false;

  const member =
    reference.members.length === 0 && reference.kind === "require"
      ? "default"
      : reference.members[0];
  if (
    reference.members.length > 1 ||
    member === undefined ||
    (member !== null && !names.includes(member))
  )
    return false;

  if (reference.unsafe || member === null) {
    if (reference.kind === "import") return false;
    if (strict)
      throw path.buildCodeFrameError(
        `Cannot safely extract ${JSON.stringify(reference.source)} export ${JSON.stringify(member ?? names[0])}: ${reference.unsafe ?? "dynamic member"}. Use mincho-js-ignore to leave this call in place.`
      );

    return false;
  }

  return true;
}
