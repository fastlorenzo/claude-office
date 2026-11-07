"use client";

import { API_BASE } from "@/utils/api";
import { useEffect } from "react";
import { useNavigationStore } from "@/stores/navigationStore";
import { usePreferencesStore } from "@/stores/preferencesStore";

/** Resolve once preferences (incl. renderer) are loaded, or after a timeout. */
function whenPrefsLoaded(): Promise<void> {
  return new Promise((resolve) => {
    if (usePreferencesStore.getState().isLoaded) return resolve();
    let unsub = (): void => {};
    const done = (): void => {
      clearTimeout(timer);
      unsub();
      resolve();
    };
    const timer = setTimeout(done, 3000);
    unsub = usePreferencesStore.subscribe((st) => {
      if (st.isLoaded) done();
    });
  });
}

const API_URL = `${API_BASE}/api/v1`;

/**
 * Fetches building configuration from the backend and stores it
 * in the navigation store. Runs once on mount.
 *
 * If no floors are configured, the store stays in "single" view mode. With the
 * 3D renderer it also stays in "single" (building views are optional).
 */
export function useFloorConfig(): void {
  const setBuildingConfig = useNavigationStore((s) => s.setBuildingConfig);
  const setLoading = useNavigationStore((s) => s.setLoading);

  useEffect(() => {
    setLoading(true);
    fetch(`${API_URL}/floors`)
      .then((res) => res.json())
      .then(async (data) => {
        await whenPrefsLoaded();
        // Backend returns camelCase (Pydantic to_camel alias)
        const config = {
          buildingName: data.buildingName ?? "Building",
          floors: ((data.floors ?? []) as Record<string, unknown>[]).map(
            (floor) => ({
              id: floor.id as string,
              name: floor.name as string,
              floorNumber: floor.floorNumber as number,
              accent: floor.accent as string,
              icon: floor.icon as string,
              rooms: ((floor.rooms ?? []) as Record<string, unknown>[]).map(
                (room) => ({
                  id: room.id as string,
                  repoName: room.repoName as string,
                }),
              ),
            }),
          ),
        };
        setBuildingConfig(config, usePreferencesStore.getState().renderer);
      })
      .catch(() => {
        setBuildingConfig({ buildingName: "Building", floors: [] });
      });
  }, [setBuildingConfig, setLoading]);
}
