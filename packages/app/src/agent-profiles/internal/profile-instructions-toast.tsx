import { useCallback, type ReactElement } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { ToastApi } from "@/components/toast-host";
import { Button } from "@/components/ui/button";

const DURATION_MS = 8000;

/** Tells the user a running agent keeps its instructions, with a way to start one that has them. */
export function showProfileInstructionsToast(input: {
  toast: ToastApi;
  message: string;
  actionLabel: string;
  onStartNewAgent: (() => void) | null;
}): void {
  const { toast, message, actionLabel, onStartNewAgent } = input;
  const dismissRef = createDismissRef();
  dismissRef.current = toast.show(
    <ProfileInstructionsToastContent
      message={message}
      actionLabel={actionLabel}
      onStartNewAgent={onStartNewAgent}
      dismissRef={dismissRef}
    />,
    { variant: "info", durationMs: DURATION_MS, testID: "profile-instructions-toast" },
  );
}

interface DismissRef {
  current: (() => void) | null;
}

// The toast's content needs the dismiss function `toast.show` returns, so it reads it late.
function createDismissRef(): DismissRef {
  return { current: null };
}

function ProfileInstructionsToastContent({
  message,
  actionLabel,
  onStartNewAgent,
  dismissRef,
}: {
  message: string;
  actionLabel: string;
  onStartNewAgent: (() => void) | null;
  dismissRef: DismissRef;
}): ReactElement {
  const handlePress = useCallback(() => {
    dismissRef.current?.();
    onStartNewAgent?.();
  }, [dismissRef, onStartNewAgent]);
  return (
    <View style={styles.content}>
      <Text style={styles.message}>{message}</Text>
      {onStartNewAgent ? (
        <Button
          variant="outline"
          size="sm"
          onPress={handlePress}
          style={styles.action}
          testID="profile-instructions-start-new-agent"
        >
          {actionLabel}
        </Button>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  content: {
    gap: theme.spacing[2],
    flexShrink: 1,
  },
  message: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  action: {
    alignSelf: "flex-start",
  },
}));
