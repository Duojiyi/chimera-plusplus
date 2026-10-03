import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";

import { SkillsPage } from "@/components/skills/SkillsPage";
import type { DiscoverableSkill, SkillRepo } from "@/lib/api/skills";

const installMutateAsyncMock = vi.fn();
let discoverableSkillsMock: DiscoverableSkill[] = [];
let skillReposMock: SkillRepo[] = [];
const refetchDiscoverableMock = vi.fn();

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock("@/hooks/useSkills", () => ({
  useDiscoverableSkills: () => ({
    data: discoverableSkillsMock,
    isLoading: false,
    isFetching: false,
    refetch: refetchDiscoverableMock,
  }),
  useInstalledSkills: () => ({
    data: [],
    isLoading: false,
  }),
  useInstallSkill: () => ({
    mutateAsync: installMutateAsyncMock,
  }),
  useSkillRepos: () => ({
    data: skillReposMock,
    refetch: vi.fn(),
  }),
  useAddSkillRepo: () => ({
    mutateAsync: vi.fn(),
  }),
  useRemoveSkillRepo: () => ({
    mutateAsync: vi.fn(),
  }),
}));

const makeDiscoverableSkill = (
  overrides: Partial<DiscoverableSkill> = {},
): DiscoverableSkill => ({
  key: "repo-skill:owner-a:repo-a",
  name: "Repo Skill",
  description: "Skill from a configured repository",
  directory: "repo-skill",
  readmeUrl: "https://example.com/repo-skill",
  repoOwner: "owner-a",
  repoName: "repo-a",
  repoBranch: "main",
  ...overrides,
});

const makeSkillRepo = (overrides: Partial<SkillRepo> = {}): SkillRepo => ({
  owner: "owner-a",
  name: "repo-a",
  branch: "main",
  enabled: true,
  ...overrides,
});

describe("SkillsPage", () => {
  beforeEach(() => {
    installMutateAsyncMock.mockReset();
    installMutateAsyncMock.mockResolvedValue({});
    discoverableSkillsMock = [];
    skillReposMock = [];
    refetchDiscoverableMock.mockReset();
  });

  it("does not offer a skills.sh search, even with no repositories", () => {
    render(<SkillsPage initialApp="claude" />);

    expect(screen.queryByRole("button", { name: /skills\.sh/i })).toBeNull();
    expect(
      screen.queryByPlaceholderText("skills.skillssh.searchPlaceholder"),
    ).toBeNull();
    expect(screen.getByText("skills.empty")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "skills.addRepo" }),
    ).toBeInTheDocument();
  });

  it("installs the selected skill from a configured repository", async () => {
    skillReposMock = [makeSkillRepo(), makeSkillRepo({ owner: "owner-b" })];
    discoverableSkillsMock = [
      makeDiscoverableSkill({ name: "Repo Skill A" }),
      makeDiscoverableSkill({
        key: "repo-skill:owner-b:repo-a",
        name: "Repo Skill B",
        repoOwner: "owner-b",
      }),
    ];

    render(<SkillsPage initialApp="claude" />);
    const user = userEvent.setup();

    const secondCard = screen
      .getByText("Repo Skill B")
      .closest("div.glass-card");
    expect(secondCard).not.toBeNull();
    const installButton = secondCard!.querySelector(
      "button:last-of-type",
    ) as HTMLButtonElement;
    expect(installButton).not.toBeNull();
    await user.click(installButton);

    await waitFor(() => {
      expect(installMutateAsyncMock).toHaveBeenCalledTimes(1);
    });
    const callArgs = installMutateAsyncMock.mock.calls[0][0];
    expect(callArgs.skill.repoOwner).toBe("owner-b");
    expect(callArgs.skill.name).toBe("Repo Skill B");
  });
});
