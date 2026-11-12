import { useCallback, useMemo, type ReactNode } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import type { StyleProp, TextStyle, ViewStyle } from "react-native";
import Animated, {
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useDerivedValue,
  withTiming,
} from "react-native-reanimated";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  createControlGeometry,
  controlIconSize,
  type ControlSize,
} from "@/components/ui/control-geometry";
import { useContainedControlSize } from "@/components/ui/control-size";
import type { Theme } from "@/styles/theme";

type SegmentedControlIconRenderer = (props: { color: string; size: number }) => ReactNode;

export interface SegmentedControlOption<T extends string> {
  value: T;
  label: string;
  accessibilityLabel?: string;
  icon?: SegmentedControlIconRenderer;
  disabled?: boolean;
  testID?: string;
}

interface SegmentedControlProps<T extends string> {
  options: SegmentedControlOption<T>[];
  value: T;
  onValueChange: (value: T) => void;
  size?: ControlSize;
  hideLabels?: boolean;
  appearance?: "ghost" | "track";
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

const THUMB_TIMING = {
  duration: 155,
  easing: Easing.out(Easing.cubic),
  reduceMotion: ReduceMotion.System,
};

function SegmentThumb({ index, count }: { index: number; count: number }) {
  const progress = useDerivedValue(() => withTiming(index, THUMB_TIMING));
  const thumbStyle = useAnimatedStyle(() => ({
    width: `${100 / count}%` as const,
    left: `${(progress.value * 100) / count}%` as const,
  }));
  return (
    <View pointerEvents="none" style={styles.thumbRail}>
      <Animated.View style={[styles.thumb, thumbStyle]} />
    </View>
  );
}

interface SegmentIconProps {
  icon: SegmentedControlIconRenderer;
  iconSize: number;
  iconColor: string;
}

function SegmentIcon({ icon, iconSize, iconColor }: SegmentIconProps) {
  return <View style={styles.iconContainer}>{icon({ color: iconColor, size: iconSize })}</View>;
}

const ThemedSegmentIcon = withUnistyles(SegmentIcon);

const selectedIconMapping = (theme: Theme) => ({ iconColor: theme.colors.foreground });
const mutedIconMapping = (theme: Theme) => ({ iconColor: theme.colors.foregroundMuted });

export function SegmentedControl<T extends string>({
  options,
  value,
  onValueChange,
  size: sizeProp,
  hideLabels = false,
  appearance = "ghost",
  accessibilityLabel,
  style,
  testID,
}: SegmentedControlProps<T>) {
  const containedSize = useContainedControlSize();
  const size = sizeProp ?? containedSize ?? "md";
  const sizeStyles = {
    sm: { container: styles.containerSm, segment: styles.segmentSm, label: styles.labelSm },
    md: { container: styles.containerMd, segment: styles.segmentMd, label: styles.labelMd },
  }[size];
  const containerSizeStyle = sizeStyles.container;
  const segmentSizeStyle = sizeStyles.segment;
  const labelSizeStyle = sizeStyles.label;
  const iconSize = controlIconSize[size];
  const hasTrack = appearance === "track";
  const selectedIndex = options.findIndex((option) => option.value === value);

  const containerStyle = useMemo(
    () => [styles.container, containerSizeStyle, hasTrack && styles.track, style],
    [containerSizeStyle, hasTrack, style],
  );

  return (
    <View
      style={containerStyle}
      testID={testID}
      role={hasTrack ? "group" : undefined}
      accessibilityLabel={accessibilityLabel}
    >
      {hasTrack && selectedIndex !== -1 ? (
        <SegmentThumb index={selectedIndex} count={options.length} />
      ) : null}
      {options.map((option) => {
        const isSelected = option.value === value;

        return (
          <SegmentItem
            key={option.value}
            option={option}
            isSelected={isSelected}
            iconSize={iconSize}
            hideLabels={hideLabels}
            hasTrack={hasTrack}
            segmentSizeStyle={segmentSizeStyle}
            labelSizeStyle={labelSizeStyle}
            currentValue={value}
            onValueChange={onValueChange}
          />
        );
      })}
    </View>
  );
}

function SegmentItem<T extends string>({
  option,
  isSelected,
  iconSize,
  hideLabels,
  hasTrack,
  segmentSizeStyle,
  labelSizeStyle,
  currentValue,
  onValueChange,
}: {
  option: SegmentedControlOption<T>;
  isSelected: boolean;
  iconSize: number;
  hideLabels: boolean;
  hasTrack: boolean;
  segmentSizeStyle: StyleProp<ViewStyle>;
  labelSizeStyle: StyleProp<TextStyle>;
  currentValue: T;
  onValueChange: (value: T) => void;
}) {
  const labelStyle = useMemo(
    () => [styles.label, labelSizeStyle, isSelected && styles.labelSelected],
    [labelSizeStyle, isSelected],
  );
  const handlePress = useCallback(() => {
    if (!option.disabled && option.value !== currentValue) {
      onValueChange(option.value);
    }
  }, [option.disabled, option.value, currentValue, onValueChange]);
  const pressableStyle = useCallback(
    ({
      hovered,
      pressed,
      focused,
    }: PressableStateCallbackType & { hovered?: boolean; focused?: boolean }) => [
      styles.segment,
      segmentSizeStyle,
      hasTrack && styles.trackSegment,
      isSelected && !hasTrack && styles.segmentSelected,
      Boolean(hovered) && !isSelected && styles.segmentHover,
      pressed && !isSelected && styles.segmentPressed,
      hasTrack && focused && styles.trackFocused,
      option.disabled && styles.segmentDisabled,
    ],
    [hasTrack, isSelected, option.disabled, segmentSizeStyle],
  );
  const accessibilityState = useMemo(
    () => ({ selected: isSelected, disabled: option.disabled }),
    [isSelected, option.disabled],
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={option.accessibilityLabel ?? option.label}
      accessibilityState={accessibilityState}
      aria-selected={isSelected}
      aria-pressed={hasTrack ? isSelected : undefined}
      disabled={option.disabled}
      testID={option.testID}
      onPress={handlePress}
      style={pressableStyle}
    >
      {option.icon ? (
        <ThemedSegmentIcon
          icon={option.icon}
          iconSize={iconSize}
          uniProps={isSelected ? selectedIconMapping : mutedIconMapping}
        />
      ) : null}
      {hideLabels ? null : (
        <Text style={labelStyle} numberOfLines={1}>
          {option.label}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => {
  const geometry = createControlGeometry(theme);

  return {
    container: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: "transparent",
      gap: theme.spacing[1],
    },
    containerSm: {
      ...geometry.segmentedContainerSm,
    },
    containerMd: {
      ...geometry.segmentedContainerMd,
    },
    track: {
      position: "relative",
      flexShrink: 0,
      gap: 0,
      padding: 2,
      borderRadius: theme.borderRadius.full,
      backgroundColor: theme.colors.surface1,
      borderWidth: theme.borderWidth[1],
      borderColor: theme.colors.border,
    },
    thumbRail: {
      position: "absolute",
      top: 2,
      bottom: 2,
      left: 2,
      right: 2,
    },
    thumb: {
      position: "absolute",
      top: 0,
      bottom: 0,
      borderRadius: theme.borderRadius.full,
      backgroundColor: theme.colors.surface3,
    },
    segment: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      flexShrink: 0,
      gap: theme.spacing[1],
    },
    segmentSm: {
      ...geometry.segmentedSegmentSm,
    },
    segmentMd: {
      ...geometry.segmentedSegmentMd,
    },
    trackSegment: {
      flexGrow: 1,
      // Content width, never narrower than 68: a fixed basis clipped labels longer than "Agent".
      flexBasis: "auto",
      minWidth: 68,
      borderRadius: theme.borderRadius.full,
      borderWidth: theme.borderWidth[1],
      borderColor: "transparent",
    },
    trackFocused: { borderColor: theme.colors.borderAccent },
    segmentSelected: {
      backgroundColor: theme.colors.surface3,
    },
    segmentHover: {
      backgroundColor: theme.colors.surface2,
    },
    segmentPressed: {
      backgroundColor: theme.colors.surface3,
    },
    segmentDisabled: {
      opacity: theme.opacity[50],
    },
    iconContainer: {
      alignItems: "center",
      justifyContent: "center",
    },
    label: {
      color: theme.colors.foregroundMuted,
      fontWeight: theme.fontWeight.normal,
    },
    labelSm: {
      ...geometry.segmentedLabelSm,
    },
    labelMd: {
      ...geometry.segmentedLabelMd,
    },
    labelSelected: {
      color: theme.colors.foreground,
    },
  };
});
