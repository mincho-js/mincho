// Shared compiler-owned wrapper; its exact AST is checked before VM reuse.
export const scopedFileScopeRuntime = `((fileScope) => {
    let parentCounter = 0;
    return {
      setFileScope(...args) {
        parentCounter = fileScope.hasFileScope()
          ? fileScope.getAndIncrementRefCounter()
          : 0;
        fileScope.setFileScope(...args);
      },
      endFileScope() {
        fileScope.endFileScope();
        for (let index = 0; index < parentCounter; index++) {
          fileScope.getAndIncrementRefCounter();
        }
      }
    };
  })(require("@vanilla-extract/css/fileScope"))`;
