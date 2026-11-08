import { useIsFocused } from "expo-router/react-navigation";
import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { ScreenHeader } from "./screen-header";
import { ScreenTitle } from "./screen-title";
import { CompactHeader } from "./compact-header";
import { SidebarMenuToggle } from "./sidebar-menu-toggle";
import { useIsCompactFormFactor } from "@/constants/layout";

interface MenuHeaderProps {
  title?: string;
  rightContent?: ReactNode;
  borderless?: boolean;
  inPimiTitlebar?: boolean;
}

// undefined is a regular screen, null is an active title bar covered by the desktop workspace.
export const PimiTitlebarSlot = createContext<HTMLDivElement | null | undefined>(undefined);

export function MenuHeader({ title, rightContent, borderless, inPimiTitlebar }: MenuHeaderProps) {
  const isCompact = useIsCompactFormFactor();
  const slot = useContext(PimiTitlebarSlot);
  if (inPimiTitlebar && slot !== undefined) {
    return slot ? (
      <PimiTitlebarHeader slot={slot} title={title} rightContent={rightContent} />
    ) : null;
  }
  if (isCompact) {
    return <CompactHeader navigation="menu" title={title} actions={rightContent} />;
  }
  return (
    <ScreenHeader
      left={
        <>
          <SidebarMenuToggle />
          {title && <ScreenTitle>{title}</ScreenTitle>}
        </>
      }
      right={rightContent}
      leftStyle={styles.left}
      borderless={borderless}
    />
  );
}

function PimiTitlebarHeader({
  slot,
  title,
  rightContent,
}: {
  slot: HTMLDivElement;
  title?: string;
  rightContent?: ReactNode;
}) {
  const focused = useIsFocused();
  if (!focused) return null;
  return createPortal(
    <View style={styles.titlebarRow}>
      {title ? <ScreenTitle testID="pimi-view-title">{title}</ScreenTitle> : null}
      <View style={styles.titlebarActions}>
        <SidebarMenuToggle />
        {rightContent}
      </View>
    </View>,
    slot,
  );
}

const styles = StyleSheet.create((theme) => ({
  left: {
    gap: theme.spacing[2],
  },
  titlebarRow: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  titlebarActions: {
    flexDirection: "row",
    alignItems: "center",
    flexShrink: 0,
    gap: theme.spacing[2],
  },
}));
