import AddRoundedIcon from "@mui/icons-material/AddRounded";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import { Box, ButtonBase, IconButton, Stack, Tooltip, Typography } from "@mui/material";
import { alpha } from "@mui/material/styles";

import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";

import { useI18n } from "@/i18n";
import { getWorkbenchFontSize } from "./SessionInspectorShared";

type SessionContainerTabItem = {
  id: string;
  isActive: boolean;
  labelNumber: number;
};

type SessionContainerTabsProps = {
  containers: SessionContainerTabItem[];
  onAddContainer: () => void;
  onCloseContainer: (containerId: string) => void;
  onSelectContainer: (containerId: string) => void;
};

const MIN_SCROLLBAR_THUMB_WIDTH = 42;

type TabScrollbarState = {
  canScroll: boolean;
  thumbLeft: number;
  thumbWidth: number;
};

function SessionContainerTabsImpl({
  containers,
  onAddContainer,
  onCloseContainer,
  onSelectContainer,
}: SessionContainerTabsProps) {
  const { t } = useI18n();
  const tabListRef = useRef<HTMLDivElement | null>(null);
  const tabButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const scrollbarTrackRef = useRef<HTMLDivElement | null>(null);
  const [scrollbarState, setScrollbarState] = useState<TabScrollbarState>({
    canScroll: false,
    thumbLeft: 0,
    thumbWidth: 0,
  });
  const [isScrollbarDragging, setIsScrollbarDragging] = useState(false);
  const activeContainerId = containers.find((container) => container.isActive)?.id;

  const updateScrollbarState = useCallback(() => {
    const tabList = tabListRef.current;

    if (!tabList) {
      return;
    }

    const { clientWidth, scrollLeft, scrollWidth } = tabList;

    if (clientWidth <= 0 || scrollWidth <= clientWidth + 1) {
      setScrollbarState((current) =>
        current.canScroll || current.thumbLeft !== 0 || current.thumbWidth !== 0
          ? { canScroll: false, thumbLeft: 0, thumbWidth: 0 }
          : current,
      );
      return;
    }

    const maxScrollLeft = scrollWidth - clientWidth;
    const thumbWidth = Math.max(
      MIN_SCROLLBAR_THUMB_WIDTH,
      (clientWidth / scrollWidth) * clientWidth,
    );
    const maxThumbLeft = Math.max(0, clientWidth - thumbWidth);
    const thumbLeft = maxScrollLeft > 0 ? (scrollLeft / maxScrollLeft) * maxThumbLeft : 0;
    const nextState = {
      canScroll: true,
      thumbLeft,
      thumbWidth,
    };

    setScrollbarState((current) =>
      current.canScroll === nextState.canScroll &&
      Math.abs(current.thumbLeft - nextState.thumbLeft) < 0.5 &&
      Math.abs(current.thumbWidth - nextState.thumbWidth) < 0.5
        ? current
        : nextState,
    );
  }, []);

  useEffect(() => {
    updateScrollbarState();

    const tabList = tabListRef.current;
    const resizeObserver =
      typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(updateScrollbarState);

    if (tabList) {
      resizeObserver?.observe(tabList);
    }

    window.addEventListener("resize", updateScrollbarState);

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", updateScrollbarState);
    };
  }, [containers.length, updateScrollbarState]);

  useEffect(() => {
    const activeButton = activeContainerId
      ? tabButtonRefs.current.get(activeContainerId)
      : undefined;

    activeButton?.scrollIntoView({ block: "nearest", inline: "nearest" });

    const animationFrameId = window.requestAnimationFrame(updateScrollbarState);

    return () => window.cancelAnimationFrame(animationFrameId);
  }, [activeContainerId, updateScrollbarState]);

  const handleTabListScroll = useCallback(() => {
    updateScrollbarState();
  }, [updateScrollbarState]);

  const handleTabListWheel = useCallback(
    (event: ReactWheelEvent<HTMLDivElement>) => {
      const tabList = tabListRef.current;

      if (!tabList) {
        return;
      }

      const maxScrollLeft = tabList.scrollWidth - tabList.clientWidth;

      if (maxScrollLeft <= 0) {
        return;
      }

      const delta = Math.abs(event.deltaX) >= Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      const nextScrollLeft = Math.max(0, Math.min(maxScrollLeft, tabList.scrollLeft + delta));

      if (nextScrollLeft === tabList.scrollLeft) {
        return;
      }

      event.preventDefault();
      tabList.scrollLeft = nextScrollLeft;
      updateScrollbarState();
    },
    [updateScrollbarState],
  );

  const handleScrollbarTrackPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const tabList = tabListRef.current;
      const track = scrollbarTrackRef.current;

      if (!tabList || !track || event.target !== event.currentTarget) {
        return;
      }

      const maxScrollLeft = tabList.scrollWidth - tabList.clientWidth;
      const maxThumbLeft = Math.max(0, track.clientWidth - scrollbarState.thumbWidth);

      if (maxScrollLeft <= 0 || maxThumbLeft <= 0) {
        return;
      }

      event.preventDefault();
      const trackBounds = track.getBoundingClientRect();
      const nextThumbLeft = Math.max(
        0,
        Math.min(maxThumbLeft, event.clientX - trackBounds.left - scrollbarState.thumbWidth / 2),
      );

      tabList.scrollLeft = (nextThumbLeft / maxThumbLeft) * maxScrollLeft;
      updateScrollbarState();
    },
    [scrollbarState.thumbWidth, updateScrollbarState],
  );

  const handleScrollbarThumbPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const tabList = tabListRef.current;
      const track = scrollbarTrackRef.current;

      if (!tabList || !track) {
        return;
      }

      const maxScrollLeft = tabList.scrollWidth - tabList.clientWidth;
      const maxThumbLeft = Math.max(0, track.clientWidth - scrollbarState.thumbWidth);

      if (maxScrollLeft <= 0 || maxThumbLeft <= 0) {
        return;
      }

      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      setIsScrollbarDragging(true);

      const startClientX = event.clientX;
      const startScrollLeft = tabList.scrollLeft;
      const scrollPerPixel = maxScrollLeft / maxThumbLeft;

      const handlePointerMove = (moveEvent: PointerEvent) => {
        const nextScrollLeft = Math.max(
          0,
          Math.min(
            maxScrollLeft,
            startScrollLeft + (moveEvent.clientX - startClientX) * scrollPerPixel,
          ),
        );

        tabList.scrollLeft = nextScrollLeft;
        updateScrollbarState();
      };

      const stopDragging = () => {
        setIsScrollbarDragging(false);
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", stopDragging);
        window.removeEventListener("pointercancel", stopDragging);
      };

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", stopDragging);
      window.addEventListener("pointercancel", stopDragging);
    },
    [scrollbarState.thumbWidth, updateScrollbarState],
  );

  return (
    <Box
      sx={{
        bgcolor: (theme) =>
          theme.palette.mode === "dark"
            ? alpha(theme.palette.background.default, 0.28)
            : alpha(theme.palette.background.default, 0.62),
        borderBottom: 1,
        borderColor: "divider",
        minWidth: 0,
      }}
    >
      <Stack
        direction="row"
        spacing={1}
        sx={{
          alignItems: "center",
          justifyContent: "space-between",
          minHeight: 42,
          px: 0.75,
          py: 0.5,
        }}
      >
        <Box
          sx={{
            alignItems: "center",
            display: "flex",
            flex: 1,
            height: 34,
            minWidth: 0,
            position: "relative",
            "&:hover .SessionContainerTabs-scrollbar, &:focus-within .SessionContainerTabs-scrollbar":
              {
                opacity: 1,
                pointerEvents: "auto",
              },
          }}
        >
          <Stack
            direction="row"
            onScroll={handleTabListScroll}
            onWheel={handleTabListWheel}
            ref={tabListRef}
            spacing={0.5}
            sx={{
              alignItems: "center",
              flex: 1,
              height: 30,
              minWidth: 0,
              overscrollBehaviorX: "contain",
              overflowX: "auto",
              overflowY: "hidden",
              scrollbarWidth: "none",
              WebkitOverflowScrolling: "touch",

              "&::-webkit-scrollbar": {
                display: "none",
              },
            }}
          >
            {containers.map((container) => (
              <ButtonBase
                key={container.id}
                onClick={() => onSelectContainer(container.id)}
                ref={(element) => {
                  if (element) {
                    tabButtonRefs.current.set(container.id, element);
                  } else {
                    tabButtonRefs.current.delete(container.id);
                  }
                }}
                sx={(theme) => ({
                  alignItems: "center",
                  bgcolor: container.isActive
                    ? alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.18 : 0.1)
                    : "transparent",
                  border: "1px solid",
                  borderColor: container.isActive
                    ? alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.38 : 0.22)
                    : "transparent",
                  borderRadius: 1.25,
                  color: container.isActive ? "text.primary" : "text.secondary",
                  cursor: "pointer",
                  display: "inline-flex",
                  flex: "0 0 auto",
                  height: 30,
                  justifyContent: "center",
                  minWidth: 0,
                  px: 1.1,
                  transition:
                    "background-color 140ms ease, border-color 140ms ease, color 140ms ease",
                  "&:hover": {
                    bgcolor: container.isActive
                      ? alpha(
                          theme.palette.primary.main,
                          theme.palette.mode === "dark" ? 0.22 : 0.13,
                        )
                      : alpha(
                          theme.palette.text.primary,
                          theme.palette.mode === "dark" ? 0.08 : 0.05,
                        ),
                    color: "text.primary",
                  },
                })}
              >
                <Typography
                  noWrap
                  sx={(theme) => ({
                    fontSize: getWorkbenchFontSize(theme, 13),
                    fontWeight: container.isActive ? 600 : 500,
                    lineHeight: 1,
                  })}
                >
                  {t("sessionsPage.containers.sessionTitle", { index: container.labelNumber })}
                </Typography>
              </ButtonBase>
            ))}
          </Stack>

          {scrollbarState.canScroll ? (
            <Box
              aria-hidden
              className="SessionContainerTabs-scrollbar"
              onPointerDown={handleScrollbarTrackPointerDown}
              ref={scrollbarTrackRef}
              sx={{
                bottom: 0,
                cursor: "pointer",
                height: 4,
                left: 0,
                opacity: isScrollbarDragging ? 1 : 0,
                pointerEvents: isScrollbarDragging ? "auto" : "none",
                position: "absolute",
                right: 0,
                transition: "opacity 140ms ease",
              }}
            >
              <Box
                onPointerDown={handleScrollbarThumbPointerDown}
                sx={(theme) => ({
                  bgcolor: alpha(
                    theme.palette.text.primary,
                    theme.palette.mode === "dark" ? 0.18 : 0.14,
                  ),
                  borderRadius: 999,
                  cursor: "grab",
                  height: 4,
                  transform: `translateX(${scrollbarState.thumbLeft}px)`,
                  transition: "background-color 120ms ease",
                  width: scrollbarState.thumbWidth,
                  "&:active": {
                    cursor: "grabbing",
                  },
                  "&:hover": {
                    bgcolor: alpha(
                      theme.palette.text.primary,
                      theme.palette.mode === "dark" ? 0.26 : 0.22,
                    ),
                  },
                })}
              />
            </Box>
          ) : null}
        </Box>

        <Box
          sx={(theme) => ({
            alignSelf: "stretch",
            borderLeft: 1,
            borderColor: alpha(theme.palette.divider, theme.palette.mode === "dark" ? 0.46 : 0.62),
            flex: "0 0 auto",
          })}
        />

        <Stack direction="row" spacing={0.25} sx={{ flex: "0 0 auto" }}>
          {containers.length > 1 ? (
            <Tooltip arrow title={t("sessionsPage.containers.close")}>
              <IconButton
                aria-label={t("sessionsPage.containers.close")}
                onClick={() => {
                  const activeContainer = containers.find((container) => container.isActive);

                  if (activeContainer) {
                    onCloseContainer(activeContainer.id);
                  }
                }}
                size="small"
                sx={{
                  borderRadius: 0.75,
                  color: "text.secondary",
                  height: 28,
                  width: 28,
                  "&:hover": {
                    bgcolor: (theme) =>
                      alpha(
                        theme.palette.text.primary,
                        theme.palette.mode === "dark" ? 0.08 : 0.05,
                      ),
                    color: "text.primary",
                  },
                }}
              >
                <CloseRoundedIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          ) : null}

          <Tooltip arrow title={t("sessionsPage.containers.add")}>
            <IconButton
              aria-label={t("sessionsPage.containers.add")}
              onClick={onAddContainer}
              size="small"
              sx={{
                borderRadius: 0.75,
                color: "text.secondary",
                height: 28,
                width: 28,
                "&:hover": {
                  bgcolor: (theme) =>
                    alpha(theme.palette.text.primary, theme.palette.mode === "dark" ? 0.08 : 0.05),
                  color: "text.primary",
                },
              }}
            >
              <AddRoundedIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Stack>
      </Stack>
    </Box>
  );
}

export const SessionContainerTabs = memo(SessionContainerTabsImpl);
