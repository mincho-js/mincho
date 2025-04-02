import {
  ComplexPropDefinitions,
  PropTarget,
  RuntimeFn,
  VariantGroups,
  VariantObjectSelection
} from "@mincho-js/css";
import {
  ComponentProps,
  ComponentType,
  createElement,
  ElementType,
  forwardRef,
  useMemo
} from "react";

export function $$styled<T extends ComponentType<unknown>>(
  component: T,
  styles: RuntimeFn<
    VariantGroups,
    ComplexPropDefinitions<PropTarget | undefined>
  >
) {
  type Props = ComponentProps<typeof component> & {
    as?: ElementType;
    className?: string;
    // Add any variant props with an index signature
    [key: string]: unknown;
  };

  const StyledComponent = forwardRef<unknown, Props>(
    ({ as, className: classNameProp, ...props }, ref) => {
      const componentToRender = as ?? component;

      // More efficient variant/props separation using predefined variant keys
      const [variantSelection, otherProps] = useMemo(() => {
        const variantSelection: VariantObjectSelection<VariantGroups> = {};
        const otherProps: Record<string, unknown> = {};

        for (const [key, value] of Object.entries(props)) {
          if (styles.variants().includes(key)) {
            variantSelection[key] = value;
          } else {
            otherProps[key] = value;
          }
        }

        return [variantSelection, otherProps];
      }, [props]);

      const className = [styles(variantSelection), classNameProp].join(" ");

      // Create element with proper types
      if (typeof componentToRender === "string") {
        return createElement(componentToRender, {
          ...otherProps,
          className,
          ref
        });
      }

      return createElement(
        componentToRender as ComponentType<{
          className?: string;
          ref?: unknown;
          [key: string]: unknown;
        }>,
        {
          ...otherProps,
          className,
          ref
        }
      );
    }
  );

  // Set component static properties
  // StyledComponent.displayName = `Mincho(${getDisplayName(component)})`;

  return StyledComponent;
}

// Helper function to get display name
// function getDisplayName(component: ComponentType<unknown>): string {
//   return component.displayName || component.name || "Component";
// }
