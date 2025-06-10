export type Resolve<T> = {
  [Key in keyof T]: T[Key];
} & {};
