import { describe, expect, it } from "vitest";
import { STATUS_COLORS, type CampusSession } from "@/engine/contracts";
import {
  agentLocomotion,
  agentPose,
  bossPose,
  roomStatus,
  statusColor,
} from "@/engine/logic/status";
import { createDemoCampus } from "@/engine/demo/demoCampus";

describe("status", () => {
  const base = createDemoCampus(1, 0).campus[0];
  const s = (p: Partial<CampusSession>): CampusSession => ({ ...base, ...p });

  it("maps room status", () => {
    expect(roomStatus(s({ ended: true, bucket: "working" }))).toBe("ended");
    expect(roomStatus(s({ ended: false, bucket: "needs_you" }))).toBe(
      "needs_you",
    );
    expect(roomStatus(s({ ended: false, bucket: "done" }))).toBe("done");
  });

  it("maps poses", () => {
    expect(bossPose("working")).toBe("typing");
    expect(bossPose("waiting_permission")).toBe("raiseHand");
    expect(bossPose("completing")).toBe("celebrating");
    expect(bossPose("idle")).toBe("sitting");
    expect(agentPose("walking_to_desk")).toBe("walking");
    expect(agentPose("working")).toBe("typing");
    expect(agentPose("thinking")).toBe("thinking");
    expect(agentPose("waiting_permission")).toBe("raiseHand");
    expect(agentPose("completed")).toBe("celebrating");
    expect(agentPose("idle")).toBe("sitting");
  });

  it("maps locomotion and colours", () => {
    expect(agentLocomotion("walking_to_desk")).toBe("toDesk");
    expect(agentLocomotion("reporting")).toBe("toBoss");
    expect(agentLocomotion("leaving")).toBe("toDoor");
    expect(agentLocomotion("arriving")).toBe("atDoor");
    expect(agentLocomotion("working")).toBe("atDesk");
    expect(statusColor("needs_you")).toBe(STATUS_COLORS.needs_you);
  });
});
