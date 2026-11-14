import { DefaultTheme, Stack, ThemeProvider } from "expo-router";
import {
  isValidElement,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
  useCallback,
  useMemo,
} from "react";
import { withUnistyles } from "react-native-unistyles";
import { AppearanceStyleBoundary } from "@/components/appearance-style-boundary";
import { isWeb } from "@/constants/platform";

type NativeStackNavigationOptions = Exclude<
  NonNullable<ComponentProps<typeof Stack>["screenOptions"]>,
  (...args: never[]) => unknown
>;

// On web the stack paints its own background under every screen. `contentStyle` covers it, so it is
// never seen; clearing it lets a backdrop theme's sky show through a clear `surfaceWindow`.
const CLEAR_STACK_THEME = {
  ...DefaultTheme,
  colors: { ...DefaultTheme.colors, background: "transparent" },
};

interface ThemedStackBaseProps {
  backgroundColor: string;
  children?: ReactNode;
  screenOptions?: NativeStackNavigationOptions;
  // Screens whose content is another navigator. That navigator owns its own screens' appearance
  // boundary; wrapping it here would remount it.
  nestedNavigatorScreens?: readonly string[];
  /** Screens with retained lifetime owners update appearance at their own leaves. */
  screenOwnedAppearance?: readonly string[];
}

interface ScreenContent {
  route: { name: string };
  children: ReactNode;
}

function ThemedStackBase({
  backgroundColor,
  children,
  screenOptions,
  nestedNavigatorScreens,
  screenOwnedAppearance,
}: ThemedStackBaseProps) {
  const themedScreenOptions = useMemo<NativeStackNavigationOptions>(
    () => ({
      ...screenOptions,
      contentStyle: [{ backgroundColor }, screenOptions?.contentStyle],
    }),
    [backgroundColor, screenOptions],
  );
  // Appearance changes remount each screen's content below the native stack, so the navigator
  // and its screen containers keep their identity. See docs/unistyles.md.
  const screenLayout = useCallback(
    ({ route, children: content }: ScreenContent): ReactElement => {
      if (
        (nestedNavigatorScreens?.includes(route.name) ||
          screenOwnedAppearance?.includes(route.name)) &&
        isValidElement(content)
      )
        return content;
      return <AppearanceStyleBoundary>{content}</AppearanceStyleBoundary>;
    },
    [nestedNavigatorScreens, screenOwnedAppearance],
  );

  const stack = (
    <Stack screenOptions={themedScreenOptions} screenLayout={screenLayout}>
      {children}
    </Stack>
  );
  return isWeb ? <ThemeProvider value={CLEAR_STACK_THEME}>{stack}</ThemeProvider> : stack;
}

export const ThemedStack = withUnistyles(ThemedStackBase, (theme) => ({
  backgroundColor: theme.colors.surfaceWindow,
}));
