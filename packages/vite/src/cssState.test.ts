import { expect, it, vi } from "vitest";
import {
  ViteCssState,
  customNormalize,
  extractedSidecarModuleId
} from "./cssState.js";

it("keeps identical CSS through sidecar renames and publishes only changed or removed output", () => {
  const invalidateModule = vi.fn();
  const state = new ViteCssState({ invalidateModule, deleteContract() {} });
  const owner = "/App.tsx";
  state.registerSidecar(owner, "/extracted_old.css.ts", "old");
  state.commitVirtualCssForSidecar(
    owner,
    "/extracted_old.css.ts",
    new Map([["virtual:css", ".red{}"]])
  );
  invalidateModule.mockClear();
  state.registerSidecar(owner, "/extracted_new.css.ts", "new");

  expect(state.getCss("virtual:css")).toBe(".red{}");
  expect(
    state.commitVirtualCssForSidecar(
      owner,
      "/extracted_new.css.ts",
      new Map([["virtual:css", ".red{}"]])
    )
  ).toEqual({ changed: 0, unchanged: 1, removed: 0 });
  expect(invalidateModule).not.toHaveBeenCalledWith("virtual:css");
  expect(state.hasSidecar("/extracted_old.css.ts")).toBe(false);

  state.commitVirtualCssForSidecar(
    owner,
    "/extracted_new.css.ts",
    new Map([["virtual:css", ".blue{}"]])
  );

  expect(invalidateModule).toHaveBeenCalledWith("virtual:css");

  invalidateModule.mockClear();
  state.commitVirtualCssForSidecar(owner, "/extracted_new.css.ts", new Map());

  expect(state.getCss("virtual:css")).toBe("");
  expect(state.isAuthorizedVirtualCss("virtual:css")).toBe(false);
  expect(invalidateModule).toHaveBeenCalledTimes(1);
});

it("clears an owner's sidecars, authorization and contracts together", () => {
  const invalidateModule = vi.fn();
  const deleteContract = vi.fn();
  const state = new ViteCssState({ invalidateModule, deleteContract });
  const owner = "/project/App.tsx";
  const sidecar = "/project/extracted_1.css.ts";
  const id = extractedSidecarModuleId(sidecar);
  const css = "\0mincho-virtual-css:/project/extracted_1.vanilla.css";
  state.registerSidecar(owner, sidecar, "export const style = 1;");
  state.registerSidecar(
    "/project/Other.tsx",
    "/project/extracted_2.css.ts",
    "other"
  );
  state.setVirtualCssForSidecar(sidecar, css, ".style { color: red; }");

  expect(state.loadSidecar(id, sidecar)).toContain("export const style");

  state.clearGeneratedCssForOwner(owner);

  expect(state.sidecarCount(owner)).toBe(0);
  expect(state.hasSidecar(sidecar)).toBe(false);
  expect(state.loadSidecar(id, sidecar)).toBeNull();
  expect(state.getModuleData(id)).toBeUndefined();
  expect(state.isAuthorizedVirtualCss(css)).toBe(false);
  expect(state.getCss(css)).toBe("");
  expect(invalidateModule).toHaveBeenCalledWith(css);
  expect(deleteContract.mock.calls.map(([value]) => value)).toEqual([
    owner,
    sidecar,
    id
  ]);
  expect(state.hasSidecar("/project/extracted_2.css.ts")).toBe(true);
});

it("keeps sidecar metadata through repeated loads using the normalized alias", () => {
  const state = new ViteCssState({
    invalidateModule() {},

    deleteContract() {}
  });

  const sidecar = "/project/extracted_1.css.ts";
  state.registerSidecar("/project/App.tsx", sidecar, "source");

  expect(state.loadSidecar(customNormalize(sidecar), sidecar)).toBe("source");
  expect(state.loadSidecar(customNormalize(sidecar), sidecar)).toBe("source");
});
