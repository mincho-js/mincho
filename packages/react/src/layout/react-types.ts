import type { ComponentPropsWithRef, ReactElement, ElementType } from "react";
import type { WithAsProp } from "../index.js";
import type {
  BoxOptions,
  HStackOptions,
  ItemOptions,
  StackOptions,
  VStackOptions
} from "@mincho-js/css/layout/core";

export type LayoutTag = keyof HTMLElementTagNameMap;
type HostProps<T extends ElementType> = ComponentPropsWithRef<T>;
type PolymorphicProps<T extends ElementType, P> = P &
  WithAsProp<T> & {
    debugLayout?: boolean;
  } & Omit<HostProps<T>, keyof P | "as" | "dir" | "color">;

export type BoxProps<T extends ElementType = "div"> = PolymorphicProps<
  T,
  BoxOptions
>;
export type StackProps<T extends ElementType = "div"> = PolymorphicProps<
  T,
  StackOptions
>;
export type HStackProps<T extends ElementType = "div"> = PolymorphicProps<
  T,
  HStackOptions
>;
export type VStackProps<T extends ElementType = "div"> = PolymorphicProps<
  T,
  VStackOptions
>;
export type ItemProps<T extends ElementType = "div"> = PolymorphicProps<
  T,
  ItemOptions
>;

export type LayoutComponent<P> = <T extends ElementType = "div">(
  props: PolymorphicProps<T, P>
) => ReactElement | null;
