import { AsyncLocalStorage } from "node:async_hooks";

type Awaitable<Value> = Value | PromiseLike<Value>;

interface RegistryStepContext {
  active: boolean;
}

interface RegistryQueueState {
  tail: Promise<void>;
  context: AsyncLocalStorage<RegistryStepContext>;
}

const REGISTRY_QUEUE = Symbol.for(
  "@mincho-js/integration/defineRulesRegistryQueue/v1"
);

type RegistryQueueGlobal = typeof globalThis & {
  [REGISTRY_QUEUE]?: RegistryQueueState;
};

function getRegistryQueueState(): RegistryQueueState {
  const registryGlobal = globalThis as RegistryQueueGlobal;

  return (registryGlobal[REGISTRY_QUEUE] ??= {
    tail: Promise.resolve(),
    context: new AsyncLocalStorage<RegistryStepContext>()
  });
}

/** Serialize registry evaluation across module copies in the same JS realm. */
export function runDefineRulesPresetRegistryStep<Result>(
  step: () => Awaitable<Result>
): Promise<Result> {
  const queue = getRegistryQueueState();
  if (queue.context.getStore()?.active) {
    return Promise.reject(
      new Error(
        "Cannot enqueue a defineRules registry step from an active registry step. Run nested work inside the current step instead."
      )
    );
  }

  const queuedStep = queue.tail.then(() => {
    const context: RegistryStepContext = { active: true };

    return queue.context.run(context, async () => {
      try {
        return await step();
      } finally {
        // Detached async work may enqueue again after its originating step ends.
        context.active = false;
      }
    });
  });

  queue.tail = queuedStep.then(
    () => undefined,
    () => undefined
  );

  return queuedStep;
}
