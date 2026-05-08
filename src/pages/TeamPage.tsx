// src/pages/TeamPage.tsx
import {
  useState,
  useEffect,
  useCallback,
} from "react";
import {
  Users,
  UserPlus,
  Shield,
  Clock,
  Star,
  Copy,
  Check,
  ChevronDown,
  Search,
  FolderOpen,
} from "lucide-react";
import Skeleton from "../components/ui/Skeleton";
import { useDelayedLoading } from "../hooks/useDelayedLoading";

import {
  doc,
  updateDoc,
  deleteDoc,
  serverTimestamp,
  setDoc,
  getDoc,
} from "firebase/firestore";
import { db } from "../lib/firebase/config";
import { useAuth } from "../context/AuthContext";
import { useAppData } from "../context/AppDataContext";
import InviteMemberModal from "../components/InviteMemberModal";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const AVATAR_COLORS = [
  "#8b5cf6",
  "#3b82f6",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#ec4899",
  "#06b6d4",
  "#84cc16",
];

function getAvatarColor(userId: string): string {
  if (!userId) return AVATAR_COLORS[0];
  return AVATAR_COLORS[userId.charCodeAt(0) % AVATAR_COLORS.length];
}

function timeAgo(ts: any): string {
  if (!ts) return "Never";

  const ms =
    typeof ts?.toMillis === "function"
      ? ts.toMillis()
      : typeof ts?.seconds === "number"
        ? ts.seconds * 1000
        : new Date(ts).getTime();

  if (!Number.isFinite(ms)) return "Never";

  const diff = Date.now() - ms;
  const m = Math.floor(diff / 60000);

  if (m < 1) return "Just now";
  if (m < 60) return `${m}m ago`;

  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;

  return `${Math.floor(h / 24)}d ago`;
}

function isOnline(ts: any): boolean {
  if (!ts) return false;

  const ms =
    typeof ts?.toMillis === "function"
      ? ts.toMillis()
      : typeof ts?.seconds === "number"
        ? ts.seconds * 1000
        : new Date(ts).getTime();

  if (!Number.isFinite(ms)) return false;

  return Date.now() - ms < 5 * 60 * 1000;
}

function isExpired(expiresAt: any): boolean {
  if (!expiresAt) return false;

  const ms =
    typeof expiresAt?.toMillis === "function"
      ? expiresAt.toMillis()
      : typeof expiresAt?.seconds === "number"
        ? expiresAt.seconds * 1000
        : new Date(expiresAt).getTime();

  if (!Number.isFinite(ms)) return false;

  return ms < Date.now();
}

const ROLE_HIERARCHY: Record<string, number> = {
  owner: 4,
  admin: 3,
  member: 2,
  viewer: 1,
};

function canManage(currentRole: string, targetRole: string): boolean {
  return (ROLE_HIERARCHY[currentRole] ?? 0) > (ROLE_HIERARCHY[targetRole] ?? 0);
}

const ROLE_BADGE: Record<string, string> = {
  owner: "bg-violet-600 text-white",
  admin: "bg-blue-100 text-blue-700",
  member: "bg-slate-100 text-slate-600",
  viewer: "bg-gray-100 text-gray-600",
};

// ─── Toast ────────────────────────────────────────────────────────────────────

function Toast({ msg, onDone }: { msg: string; onDone: () => void }) {
  useEffect(() => {
    const t = window.setTimeout(onDone, 3000);
    return () => window.clearTimeout(t);
  }, [onDone]);

  return (
    <div
      className="fixed bottom-6 right-6 z-50 bg-slate-800 text-white px-4 py-3 rounded-xl shadow-lg text-sm"
      style={{ animation: "slideUp 0.2s ease" }}
    >
      {msg}
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function TeamPage() {
  const { user, workspaceId, setWorkspaceId } = useAuth();
    const {
    members,
    workspacePeople,
    pendingInvites,
    workspaceData,
    cancelInvite,
    projects,
  } = useAppData();



   /**
   * Workspace-scoped data lives outside the main AppDataContext loading flag.
   * So TeamPage derives its own loading state.
   *
   * If the signed-in user is a project-collaborator-only user (not a member
   * of any workspace they can read), workspaceData will never load. In that
   * case we time out after 2.5s and render the empty-state UI instead of
   * looping skeletons forever.
   */
  const teamLoading = !workspaceData;

  const [mounted, setMounted] = useState(false);
  const [loadTimedOut, setLoadTimedOut] = useState(false);

  useEffect(() => {
    const t = window.setTimeout(() => setMounted(true), 0);
    return () => window.clearTimeout(t);
  }, []);

  useEffect(() => {
    if (!teamLoading) {
      setLoadTimedOut(false);
      return;
    }
    const t = window.setTimeout(() => setLoadTimedOut(true), 2500);
    return () => window.clearTimeout(t);
  }, [teamLoading]);

  const showSkeleton = useDelayedLoading(
    (teamLoading && !loadTimedOut) || !mounted,
    {
      delay: 0,
      minDisplay: 800,
    }
  );

  const [search, setSearch] = useState("");

  const [showInvite, setShowInvite] = useState(false);
  const [toast, setToast] = useState("");
  const [copiedWid, setCopiedWid] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [roleMenuFor, setRoleMenuFor] = useState<string | null>(null);
  const [cancellingCode, setCancellingCode] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);

  const showToast = useCallback((msg: string) => setToast(msg), []);

  /**
   * IMPORTANT:
   * The real owner must come from workspaceData.ownerId.
   * If that is missing, fallback to the current authenticated user.
   *
   * Do NOT infer the real owner from member.role === "owner", because old
   * corrupted data may incorrectly mark invited users as owners.
   */
  const ownerUserId = workspaceData?.ownerId ?? user?.uid ?? null;

  const ownerMember =
    members.find((m) => m.userId === ownerUserId) ??
    (user
      ? {
          userId: user.uid,
          email: user.email ?? "",
          displayName:
            user.displayName ??
            user.email?.split("@")[0] ??
            "Workspace owner",
          role: "owner",
        }
      : null);

  const activeMembersRaw = members.filter(
    (m) => (m.status ?? "active") === "active"
  );

  const myMember = members.find((m) => m.userId === user?.uid);

  /**
   * Current user's permission role.
   * If current user is the true owner, force role = owner.
   * If bad data says current user is owner but they are not ownerUserId,
   * treat them as a normal member.
   */
  const myRole =
    user?.uid && user.uid === ownerUserId
      ? "owner"
      : myMember?.role === "owner"
        ? "member"
        : myMember?.role ?? "member";

   /**
   * Workspace members = full internal workspace users.
   * Guests = project-level collaborators indexed into /workspaces/{id}/people.
   */
  const visibleMembers = activeMembersRaw.filter((m) => {
  if (!m.userId) return false;

  // Keep the true owner out of the regular teammates list.
  // The owner is already shown in Workspace Info.
  if (m.userId === ownerUserId) return false;

  // IMPORTANT:
  // Do NOT hide the current signed-in workspace member.
  // Account B should see themselves as part of Account A's workspace.
  return true;
});


  const activeMemberIds = new Set(activeMembersRaw.map((m) => m.userId));

  /**
   * Set of project IDs that currently exist in the live workspace.
   * Used to filter out a guest's projects whose underlying project doc
   * has been deleted ("orphaned" guest entries).
   *
   * Without this, a guest can vanish from the UI silently because their
   * /people record references projects that no longer exist in /projects.
   * See PROJECT MEMORY for the riftzone orphan that motivated this guard.
   */
  const livePidSet = new Set(
    projects.map((p) => p.id).filter(Boolean) as string[]
  );

  function getActiveGuestProjects(person: any) {
    const personProjects = person.projects ?? {};
    return Object.entries(personProjects)
      .filter(([pid, p]: [string, any]) => {
        if ((p?.status ?? "active") !== "active") return false;
        // Hide entries whose project was deleted from the live projects collection.
        if (!livePidSet.has(pid)) return false;
        return true;
      })
      .map(([pid, p]: [string, any]) => ({
        ...(p as any),
        projectId: pid,
      })) as any[];
  }


  const externalGuests = workspacePeople.filter((p) => {
    const personId = p.userId || p.uid;
    if (!personId) return false;

    // Do not duplicate full workspace members in the guest section.
    if (activeMemberIds.has(personId)) return false;

    if ((p.type ?? "guest") !== "guest") return false;
    if ((p.status ?? "active") !== "active") return false;

    return getActiveGuestProjects(p).length > 0;
  });

  const filtered = visibleMembers.filter((m) => {
    const q = search.toLowerCase().trim();
    if (!q) return true;

    return (
      (m.displayName || "").toLowerCase().includes(q) ||
      (m.email || "").toLowerCase().includes(q)
    );
  });

  const filteredGuests = externalGuests.filter((p) => {
    const q = search.toLowerCase().trim();
    if (!q) return true;

    const activeProjects = getActiveGuestProjects(p);

    return (
      (p.displayName || "").toLowerCase().includes(q) ||
      (p.email || "").toLowerCase().includes(q) ||
      activeProjects.some((project: any) =>
        (project.projectName || "").toLowerCase().includes(q)
      )
    );
  });


  // ── Workspace initialization ───────────────────────────────────────────────
  // Only creates workspace doc + owner member doc for the TRUE owner.
  // Invitees already have their member doc from JoinWorkspacePage and must
  // NEVER be overwritten here with role:"owner".

  useEffect(() => {
    if (!workspaceId || !user) return;

    const init = async () => {
      try {
        const wsRef = doc(db, "workspaces", workspaceId);
        const memberRef = doc(
          db,
          "workspaces",
          workspaceId,
          "members",
          user.uid
        );

        const [wsSnap, memberSnap] = await Promise.all([
          getDoc(wsRef),
          getDoc(memberRef),
        ]);

        // Create workspace doc only when it does not exist.
        if (!wsSnap.exists()) {
          await setDoc(wsRef, {
            id: workspaceId,
            workspaceId,
            name: `${
              user.displayName ?? user.email?.split("@")[0] ?? "My"
            }'s Workspace`,
            ownerId: user.uid,
            ownerEmail: user.email ?? "",
            createdAt: serverTimestamp(),
            memberCount: 1,
            plan: "free",
          });
        }

               // Create member doc ONLY when missing AND this user is the TRUE owner
        // of THIS workspace.
        //
        // Project-collaborator-only users (external guests) must NEVER get a
        // members doc here, even if their AuthContext somehow points workspaceId
        // at this workspace. They belong in /people, not /members.
        if (!memberSnap.exists()) {
          const freshWs = wsSnap.exists() ? wsSnap : await getDoc(wsRef);
          const wsOwnerId = freshWs.data()?.ownerId;

          // Hard guard: only the workspace's true owner can self-create a
          // member doc. Everyone else is a guest, an invitee that should
          // already have a member doc from JoinWorkspacePage, or someone
          // who shouldn't be here at all.
          if (!wsOwnerId || wsOwnerId !== user.uid) {
            console.log(
              "[TeamPage] init: skipping member doc creation — not workspace owner.",
              { wsOwnerId, currentUid: user.uid, workspaceId }
            );
            return;
          }

          await setDoc(memberRef, {
            userId: user.uid,
            email: user.email ?? "",
            displayName:
              user.displayName ?? user.email?.split("@")[0] ?? "Owner",
            avatar: (user.displayName ?? user.email ?? "O")[0].toUpperCase(),
            avatarColor: getAvatarColor(user.uid),
            role: "owner",
            status: "active",
            joinedAt: serverTimestamp(),
            invitedBy: "",
            lastActive: serverTimestamp(),
            permissions: {
              canCreateProjects: true,
              canDeleteProjects: true,
              canInviteMembers: true,
              canManageTasks: true,
            },
          });
        }

      } catch (err) {
        console.error("[TeamPage] init error:", err);
      }
    };

    init();
  }, [workspaceId, user]);

   // ── Actions ───────────────────────────────────────────────────────────────

  async function changeRole(userId: string, name: string, newRole: string) {
    if (!workspaceId) return;

    if (userId === ownerUserId) {
      showToast("The workspace owner role cannot be changed here.");
      setRoleMenuFor(null);
      return;
    }

    try {
      await updateDoc(doc(db, "workspaces", workspaceId, "members", userId), {
        role: newRole,
        updatedAt: serverTimestamp(),
      });

      setRoleMenuFor(null);
      showToast(
        `${name} is now a${/^[aeiou]/i.test(newRole) ? "n" : ""} ${newRole}`
      );
    } catch (err) {
      console.error("[TeamPage] changeRole error:", err);
      showToast("Failed to update role.");
    }
  }

  async function removeMember(memberId: string, name: string) {
    if (!workspaceId || !memberId) return;

    const target = members.find((m) => m.userId === memberId);

    const targetRole =
      memberId === ownerUserId
        ? "owner"
        : target?.role === "owner"
          ? "member"
          : target?.role ?? "member";

    if (memberId === user?.uid) {
      showToast("You cannot remove yourself from this screen.");
      setConfirmRemove(null);
      return;
    }

    if (memberId === ownerUserId) {
      showToast("The workspace owner cannot be removed.");
      setConfirmRemove(null);
      return;
    }

    if (!canManage(myRole, targetRole)) {
      showToast("You do not have permission to remove this member.");
      setConfirmRemove(null);
      return;
    }

    try {
      /**
       * Correct dynamic workflow:
       * 1. Provision removed user's personal workspace.
       * 2. Update users/{memberId}.workspaceId to their personal workspace.
       * 3. Delete them from the old workspace members collection.
       *
       * Account B's AuthContext listens to users/{uid}.workspaceId,
       * so the workspace switches dynamically without refresh.
       */
      await resetRemovedUserWorkspace(memberId);

      await deleteDoc(doc(db, "workspaces", workspaceId, "members", memberId));

      setConfirmRemove(null);
      showToast(`${name || "Member"} has been removed from the workspace`);
    } catch (err) {
      console.error("[TeamPage] removeMember error:", err);
      showToast("Failed to remove member. Please try again.");
    }
  }

  async function resetRemovedUserWorkspace(memberId: string) {
    if (!memberId) return;

    const removedUserRef = doc(db, "users", memberId);
    const removedUserSnap = await getDoc(removedUserRef);

    const removedData = removedUserSnap.exists()
      ? (removedUserSnap.data() as any)
      : {};

    const existingPersonalWsId =
      typeof removedData.personalWorkspaceId === "string" &&
      removedData.personalWorkspaceId.trim()
        ? removedData.personalWorkspaceId.trim()
        : "";

    const safeMemberId = memberId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24);

    const personalWsId =
      existingPersonalWsId || `WF-PERSONAL-${safeMemberId}`;


    const displayName =
      removedData.displayName ??
      removedData.email?.split("@")[0] ??
      "User";

    const email = removedData.email ?? "";
    const photoURL = removedData.photoURL ?? "";

    // 1. Provision personal workspace.
    const personalWsRef = doc(db, "workspaces", personalWsId);
    const personalWsSnap = await getDoc(personalWsRef);

    if (!personalWsSnap.exists()) {
      await setDoc(
        personalWsRef,
        {
          id: personalWsId,
          workspaceId: personalWsId,
          name: displayName ? `${displayName}'s Workspace` : "My Workspace",
          ownerId: memberId,
          ownerEmail: email,
          plan: "free",
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
          memberCount: 1,
        },
        { merge: true }
      );
    }

    // 2. Ensure removed user is owner of their personal workspace.
    await setDoc(
      doc(db, "workspaces", personalWsId, "members", memberId),
      {
        userId: memberId,
        displayName,
        email,
        photoURL,
        avatar: (displayName || email || "U")[0].toUpperCase(),
        avatarColor: getAvatarColor(memberId),
        role: "owner",
        status: "active",
        joinedAt: serverTimestamp(),
        lastActive: serverTimestamp(),
        invitedBy: "",
        permissions: {
          canCreateProjects: true,
          canDeleteProjects: true,
          canInviteMembers: true,
          canManageTasks: true,
        },
      },
      { merge: true }
    );

      /**
     * 3. Update removed user's active workspace LAST.
     *
     * This is the realtime trigger watched by AuthContext.
     *
     * IMPORTANT:
     * Do not update displayName/email/photoURL here.
     * Firestore rules only allow workspace admins to update workspace-switch
     * fields on another user's document.
     */
    await updateDoc(removedUserRef, {
      workspaceId: personalWsId,
      personalWorkspaceId: personalWsId,
      lastRemovedFromWorkspaceId: workspaceId,
      removedFromWorkspaceAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });


    // Extra safety only if current user is the removed user.
    if (memberId === user?.uid) {
      setWorkspaceId(personalWsId);
    }
  }

  const handleCancelInvite = async (inviteCode: string) => {
    if (cancellingCode) return;

    setCancellingCode(inviteCode);
    setCancelError(null);

    try {
      await cancelInvite(inviteCode);
    } catch {
      setCancelError("Failed to cancel invite. Please try again.");
      setTimeout(() => setCancelError(null), 4000);
    } finally {
      setCancellingCode(null);
    }
  };

  async function resendInvite(invite: any) {
    if (!workspaceId) return;

    try {
      const newExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

      await updateDoc(
        doc(db, "workspaces", workspaceId, "invites", invite.code),
        {
          expiresAt: newExpiry,
          updatedAt: serverTimestamp(),
        }
      );

      showToast(`Invitation resent to ${invite.email}`);
    } catch (err) {
      console.error("[TeamPage] resendInvite error:", err);
      showToast("Failed to resend invite.");
    }
  }

  function copyWorkspaceId() {
    navigator.clipboard.writeText(workspaceId ?? "").then(() => {
      setCopiedWid(true);
      setTimeout(() => setCopiedWid(false), 2000);
      showToast("Workspace ID copied to clipboard");
    });
  }

  // ── Derived stats ─────────────────────────────────────────────────────────

  // Teammates shown in the workspace members list. Excludes owner/current user.
  const activeCount = visibleMembers.length;

  // Full workspace users only. Guests are not billing/workspace members.
  const workspaceUserCount = activeMembersRaw.length;

  const guestCount = externalGuests.length;
  const pendingCount = pendingInvites.length;
  const plan = workspaceData?.plan ?? "free";


  const STATS = [
    {
  label: "Workspace Users",
  value: workspaceUserCount,
  icon: Users,
  bg: "bg-violet-100",
  color: "text-violet-600",
},

    {
      label: "External Guests",
      value: guestCount,
      icon: Shield,
      bg: "bg-blue-100",
      color: "text-blue-600",
    },
    {
      label: "Pending Invites",
      value: pendingCount,
      icon: Clock,
      bg: "bg-orange-100",
      color: "text-orange-500",
    },
    {
      label: "Workspace Plan",
      value: plan === "pro" ? "Pro" : "Free",
      icon: Star,
      bg: "bg-emerald-100",
      color: "text-emerald-600",
    },
  ];


  const wsName =
    workspaceData?.name ??
    `${user?.displayName ?? user?.email?.split("@")[0] ?? "My"}'s Workspace`;
const canInviteWorkspaceMembers = myRole === "owner" || myRole === "admin";

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="ml-0 bg-[#f4f5f7] min-h-screen overflow-y-auto">
      <div className="max-w-6xl mx-auto px-6 pt-14 pb-10">
        {/* Header */}
<div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 mb-6">
  <div>
    <h1 className="text-2xl font-bold text-slate-800 tracking-tight">
      People & Access
    </h1>
    <p className="text-sm text-slate-400 mt-0.5">
      Manage workspace members, external guests, roles, and invitations.
    </p>
  </div>

  {canInviteWorkspaceMembers && (
    <button
      type="button"
      onClick={() => setShowInvite(true)}
      disabled={!workspaceId || showSkeleton}
      className="inline-flex items-center justify-center gap-2 rounded-xl bg-violet-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-violet-700 active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed"
    >
      <UserPlus size={16} />
      Invite Workspace Member
    </button>
  )}
</div>


        {/* Educational Banner */}
        <div className="mb-8 bg-violet-50 border border-violet-100 rounded-2xl p-5 flex items-start gap-4 shadow-sm">
          <div className="w-10 h-10 rounded-full bg-violet-100 flex items-center justify-center flex-shrink-0 mt-0.5">
            <Users size={20} className="text-violet-600" />
          </div>

          <div>
            <h3 className="text-sm font-bold text-slate-800">
  Workspace Members vs External Guests
</h3>
<p className="text-sm text-slate-600 mt-1">
  Workspace members have full workspace-level access. Project collaborators
  appear here as external guests and only have access to the specific projects
  shared with them.
</p>


          </div>
        </div>

        {/* Stat cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          {showSkeleton
            ? Array.from({ length: 4 }).map((_, i) => (
                <div
                  key={`team-stat-skel-${i}`}
                  className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 flex items-center gap-4"
                  aria-hidden="true"
                >
                  <Skeleton
                    width={40}
                    height={40}
                    className="rounded-xl flex-shrink-0"
                  />
                  <div className="flex-1">
                    <Skeleton height={22} width={48} className="mb-1.5" />
                    <Skeleton height={10} width={90} />
                  </div>
                </div>
              ))
            : STATS.map((s) => (
                <div
                  key={s.label}
                  className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 flex items-center gap-4"
                >
                  <div
                    className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${s.bg}`}
                  >
                    <s.icon size={20} className={s.color} />
                  </div>

                  <div>
                    <p className="text-2xl font-bold text-slate-800">
                      {s.value}
                    </p>
                    <p className="text-xs text-slate-400">{s.label}</p>
                  </div>
                </div>
              ))}
        </div>

        {/* Main grid */}
        <div className="flex flex-col lg:flex-row gap-6 items-start">
          {/* LEFT — Members list */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-3">
              <h2 className="text-sm font-semibold text-slate-800">
  Workspace Members
</h2>


              {showSkeleton ? (
                <Skeleton height={18} width={28} className="rounded-full" />
              ) : (
                <span className="text-xs bg-violet-100 text-violet-700 px-2 py-0.5 rounded-full font-medium">
                  {activeCount}
                </span>
              )}
            </div>

            {/* Search */}
            <div className="relative mb-4">
              <Search
                className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
                size={15}
              />
              <input
                type="text"
               placeholder="Search members, guests, or projects..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full bg-white border border-slate-200 rounded-xl pl-9 pr-4 py-2.5 text-sm text-slate-600 focus:outline-none focus:border-violet-400 transition-colors"
              />
            </div>

            {/* Members */}
            {showSkeleton ? (
              <div className="space-y-3">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div
                    key={`member-skel-${i}`}
                    className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4"
                    aria-hidden="true"
                  >
                    <div className="flex items-center gap-3">
                      <Skeleton
                        width={40}
                        height={40}
                        circle
                        className="flex-shrink-0"
                      />
                      <div className="flex-1 min-w-0">
                        <Skeleton height={12} className="w-1/3 mb-1.5" />
                        <Skeleton height={10} className="w-2/3" />
                      </div>
                      <Skeleton
                        height={16}
                        width={56}
                        className="rounded-full flex-shrink-0"
                      />
                    </div>

                    <div className="flex items-center gap-4 mt-2">
                      <Skeleton height={10} width={90} />
                      <Skeleton height={10} width={110} />
                    </div>
                  </div>
                ))}
              </div>
            ) : filtered.length === 0 &&
    visibleMembers.length === 0 &&
    filteredGuests.length === 0 &&
    externalGuests.length === 0 ? (

              <div className="bg-white rounded-2xl border border-slate-200 border-dashed py-20 flex flex-col items-center justify-center gap-3">
  <Users size={48} className="text-violet-200" strokeWidth={1} />

  <p className="text-sm font-medium text-slate-700">
    No workspace teammates yet
  </p>

  <p className="text-xs text-slate-400 text-center max-w-xs">
    Invite workspace members to collaborate across your full workspace.
    Project-only collaborators will appear below as external guests.
  </p>

  {canInviteWorkspaceMembers && (
    <button
      type="button"
      onClick={() => setShowInvite(true)}
      disabled={!workspaceId}
      className="mt-2 inline-flex items-center justify-center gap-2 rounded-xl bg-violet-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-violet-700 active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed"
    >
      <UserPlus size={16} />
      Invite Workspace Member
    </button>
  )}
</div>

            ) : filtered.length === 0 ? (
  <div className="bg-white rounded-2xl border border-slate-200 py-12 flex flex-col items-center gap-2">
    <FolderOpen
      size={36}
      className="text-slate-300"
      strokeWidth={1}
    />

    {search.trim() ? (
      <p className="text-sm text-slate-400">
        No people match your search
      </p>
    ) : (
      <>
  <p className="text-sm font-medium text-slate-700">
    No workspace teammates yet
  </p>

  <p className="text-xs text-slate-400 text-center max-w-xs">
    Invite workspace members to collaborate across your full workspace.
  </p>

  {canInviteWorkspaceMembers && (
    <button
      type="button"
      onClick={() => setShowInvite(true)}
      disabled={!workspaceId}
      className="mt-2 inline-flex items-center justify-center gap-2 rounded-xl bg-violet-600 px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-violet-700 active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed"
    >
      <UserPlus size={14} />
      Invite Workspace Member
    </button>
  )}
</>

    )}
  </div>
) : (

              <div className="space-y-3">
                {filtered.map((member) => {
                  const isOwnerMember = member.userId === ownerUserId;

                  /**
                   * Defensive normalization:
                   * If old data incorrectly marked Paul/another invitee as owner,
                   * only ownerUserId is treated as the real owner.
                   */
                  const displayRole =
                    isOwnerMember
                      ? "owner"
                      : member.role === "owner"
                        ? "member"
                        : member.role ?? "member";

                  const isMe = member.userId === user?.uid;

                  const canAct =
                    !isOwnerMember &&
                    !isMe &&
                    canManage(myRole, displayRole);

                  const online = isOnline(member.lastActive);
                  const initials = (
                    member.displayName ||
                    member.email ||
                    "?"
                  )[0].toUpperCase();

                  const bgColor =
                    member.avatarColor || getAvatarColor(member.userId || "x");

                  const confirmingRemove = confirmRemove === member.userId;

                  return (
                    <div
                      key={member.userId}
                      className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4 hover:shadow-md transition-all"
                    >
                      {/* Row 1 */}
                      <div className="flex items-center gap-3">
                        <div className="relative flex-shrink-0">
                          <div
                            className="w-10 h-10 rounded-full flex items-center justify-center text-white font-bold text-sm"
                            style={{ backgroundColor: bgColor }}
                          >
                            {initials}
                          </div>

                          {online && (
                            <span className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-emerald-500 rounded-full border-2 border-white" />
                          )}
                        </div>

                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-semibold text-slate-800 truncate">
                            {isOwnerMember && <span className="mr-1">👑</span>}
                            {member.displayName || member.email}
                            {isMe && (
                              <span className="ml-1 text-xs text-slate-400 font-normal">
                                (you)
                              </span>
                            )}
                          </p>
                          <p className="text-xs text-slate-400 truncate">
                            {member.email}
                          </p>
                        </div>

                        <span
                          className={`text-[10px] px-2 py-0.5 rounded-full font-semibold capitalize flex-shrink-0 ${
                            ROLE_BADGE[displayRole] ?? ROLE_BADGE.member
                          }`}
                        >
                          {displayRole}
                        </span>
                      </div>

                      {/* Row 2 */}
                      <div className="flex items-center gap-4 mt-2 text-xs text-slate-400">
                        {member.joinedAt && (
                          <span>Joined {timeAgo(member.joinedAt)}</span>
                        )}
                        <span>Last active {timeAgo(member.lastActive)}</span>
                      </div>

                      {/* Row 3 — Actions */}
                      {canAct && !confirmingRemove && (
                        <div className="flex items-center gap-2 mt-3 pt-3 border-t border-slate-50">
                          <div className="relative">
                            <button
                              onClick={() =>
                                setRoleMenuFor(
                                  roleMenuFor === member.userId
                                    ? null
                                    : member.userId
                                )
                              }
                              className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-800 border border-slate-200 rounded-lg px-2.5 py-1.5 transition-colors"
                            >
                              Change Role <ChevronDown size={12} />
                            </button>

                            {roleMenuFor === member.userId && (
                              <div className="absolute top-full left-0 mt-1 bg-white border border-slate-200 rounded-xl shadow-lg z-20 w-36 overflow-hidden">
                                {["admin", "member", "viewer"]
                                  .filter((r) => r !== displayRole)
                                  .map((r) => (
                                    <button
                                      key={r}
                                      onClick={() =>
                                        changeRole(
                                          member.userId,
                                          member.displayName ||
                                            member.email ||
                                            "Member",
                                          r
                                        )
                                      }
                                      className="w-full px-4 py-2 text-xs text-left text-slate-700 hover:bg-violet-50 hover:text-violet-700 capitalize transition-colors"
                                    >
                                      {r}
                                    </button>
                                  ))}
                              </div>
                            )}
                          </div>

                          <button
                            onClick={() => setConfirmRemove(member.userId)}
                            className="text-xs text-red-500 hover:text-red-700 border border-red-100 hover:border-red-300 rounded-lg px-2.5 py-1.5 transition-colors"
                          >
                            Remove
                          </button>
                        </div>
                      )}

                      {/* Confirm remove */}
                      {confirmingRemove && (
                        <div className="mt-3 pt-3 border-t border-slate-100 bg-red-50 rounded-xl p-3">
                          <p className="text-xs text-slate-700 mb-2">
                            Remove{" "}
                            <span className="font-semibold">
                              {member.displayName ||
                                member.email ||
                                "this member"}
                            </span>{" "}
                            from the workspace?
                          </p>

                          <div className="flex gap-2">
                            <button
                              onClick={() => setConfirmRemove(null)}
                              className="flex-1 text-xs py-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-white transition-colors"
                            >
                              Cancel
                            </button>

                            <button
                              onClick={() =>
                                removeMember(
                                  member.userId,
                                  member.displayName ||
                                    member.email ||
                                    "Member"
                                )
                              }
                              className="flex-1 text-xs py-1.5 rounded-lg bg-red-500 text-white hover:bg-red-600 transition-colors"
                            >
                              Remove
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
                        {/* External Guests */}
            {!showSkeleton && externalGuests.length > 0 && (
              <div className="mt-8">
                <div className="flex items-center gap-2 mb-3">
                  <h2 className="text-sm font-semibold text-slate-800">
                    External Guests
                  </h2>
                  <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full font-medium">
                    {filteredGuests.length}
                  </span>
                </div>

                {filteredGuests.length === 0 ? (
                  <div className="bg-white rounded-2xl border border-slate-200 py-10 flex flex-col items-center gap-2">
                    <FolderOpen
                      size={32}
                      className="text-slate-300"
                      strokeWidth={1}
                    />
                    <p className="text-sm text-slate-400">
                      No guests match your search
                    </p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {filteredGuests.map((guest) => {
                      const guestId = guest.userId || guest.uid || guest.email;
                      const activeProjects = getActiveGuestProjects(guest);
                      const primaryProject = activeProjects[0] as any;

                      const displayRole =
                        primaryProject?.role ?? "viewer";

                      const initials = (
                        guest.displayName ||
                        guest.email ||
                        "?"
                      )[0].toUpperCase();

                      const bgColor =
                        guest.avatarColor || getAvatarColor(guestId || "guest");

                      const online = isOnline(guest.lastActive);

                      return (
                        <div
                          key={guestId}
                          className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4 hover:shadow-md transition-all"
                        >
                          <div className="flex items-center gap-3">
                            <div className="relative flex-shrink-0">
                              <div
                                className="w-10 h-10 rounded-full flex items-center justify-center text-white font-bold text-sm overflow-hidden"
                                style={{ backgroundColor: bgColor }}
                              >
                                {guest.photoURL ? (
                                  <img
                                    src={guest.photoURL}
                                    alt={guest.displayName || guest.email}
                                    className="w-10 h-10 rounded-full object-cover"
                                    onError={(e) => {
                                      (
                                        e.currentTarget as HTMLImageElement
                                      ).style.display = "none";
                                    }}
                                  />
                                ) : (
                                  initials
                                )}
                              </div>

                              {online && (
                                <span className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-emerald-500 rounded-full border-2 border-white" />
                              )}
                            </div>

                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-semibold text-slate-800 truncate">
                                {guest.displayName || guest.email}
                              </p>
                              <p className="text-xs text-slate-400 truncate">
                                {guest.email}
                              </p>
                            </div>

                          <span className="text-[10px] px-2 py-0.5 rounded-full font-semibold capitalize flex-shrink-0 bg-blue-100 text-blue-700">
  Project-only
</span>

                          </div>

                          <div className="flex flex-wrap items-center gap-2 mt-3 text-xs text-slate-400">
                            <span>
                              Access to{" "}
                              <span className="font-semibold text-slate-600">
                                {activeProjects.length}
                              </span>{" "}
                              project{activeProjects.length === 1 ? "" : "s"}
                            </span>

                            {primaryProject?.projectName && (
                              <span className="px-2 py-0.5 bg-slate-100 text-slate-600 rounded-full">
                                {primaryProject.projectName}
                              </span>
                            )}

                            {activeProjects.length > 1 && (
                              <span className="px-2 py-0.5 bg-slate-100 text-slate-500 rounded-full">
                                +{activeProjects.length - 1} more
                              </span>
                            )}
                          </div>

                          <div className="flex items-center justify-between mt-2">
                            <span
                              className={`text-[10px] px-2 py-0.5 rounded-full font-semibold capitalize ${
                                ROLE_BADGE[displayRole] ?? ROLE_BADGE.viewer
                              }`}
                            >
                              {displayRole}
                            </span>

                            <span className="text-xs text-slate-400">
                              Last active {timeAgo(guest.lastActive)}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* RIGHT — Pending Invites + Workspace Info */}
          <div className="w-full lg:w-80 flex-none flex flex-col gap-4">
            {/* Pending Invites */}
            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold text-slate-800">
                  Pending Invites
                </h3>

                {showSkeleton ? (
                  <Skeleton height={18} width={24} className="rounded-full" />
                ) : (
                  pendingCount > 0 && (
                    <span className="text-xs bg-orange-100 text-orange-600 px-2 py-0.5 rounded-full font-medium">
                      {pendingCount}
                    </span>
                  )
                )}
              </div>

              {cancelError && (
                <div className="mb-4 bg-red-50 border border-red-200 text-red-600 px-3 py-2 rounded-xl text-xs flex items-center justify-between">
                  <span>{cancelError}</span>
                  <button
                    onClick={() => setCancelError(null)}
                    className="text-red-400 hover:text-red-600 ml-2"
                  >
                    ✕
                  </button>
                </div>
              )}

              {showSkeleton ? (
                <div className="space-y-3">
                  {Array.from({ length: 2 }).map((_, i) => (
                    <div
                      key={`invite-skel-${i}`}
                      className="border border-slate-100 rounded-xl p-3 flex flex-col gap-2"
                      aria-hidden="true"
                    >
                      <div className="flex items-center justify-between">
                        <Skeleton height={12} className="flex-1 max-w-[140px]" />
                        <Skeleton
                          height={16}
                          width={48}
                          className="rounded-full flex-shrink-0 ml-2"
                        />
                      </div>

                      <Skeleton height={9} width={160} />

                      <div className="flex gap-2 mt-1">
                        <Skeleton height={24} className="flex-1 rounded-lg" />
                        <Skeleton height={24} className="flex-1 rounded-lg" />
                      </div>
                    </div>
                  ))}
                </div>
              ) : pendingInvites.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-8 gap-2">
                  <div className="text-2xl">📭</div>
                  <p className="text-xs text-slate-400">No pending invites</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {pendingInvites.map((inv) => {
                    const expired = isExpired(inv.expiresAt);
                    const isCancelling = cancellingCode === inv.code;

                    return (
                      <div
                        key={inv.code}
                        className="border border-slate-100 rounded-xl p-3 flex flex-col gap-2"
                      >
                        <div className="flex items-center justify-between">
                          <p className="text-sm font-bold text-slate-700 truncate mr-2">
                            {inv.email}
                          </p>

                          {expired ? (
                            <span className="text-[10px] bg-red-100 text-red-600 px-2 py-0.5 rounded-full font-medium flex-shrink-0">
                              Expired
                            </span>
                          ) : (
                            <span
                              className={`text-[10px] px-2 py-0.5 rounded-full font-medium flex-shrink-0 capitalize ${
                                ROLE_BADGE[inv.role] ?? ROLE_BADGE.member
                              }`}
                            >
                              {inv.role}
                            </span>
                          )}
                        </div>

                        <p className="text-[10px] text-slate-400">
                          Sent {timeAgo(inv.createdAt)} · Code:{" "}
                          <span className="font-mono">
                            {inv.inviteCode || inv.code}
                          </span>
                        </p>

                        <div className="flex gap-2 mt-1">
                          <button
                            onClick={() => resendInvite(inv)}
                            disabled={!!cancellingCode}
                            className="flex-1 text-[10px] py-1.5 rounded-lg text-violet-600 hover:bg-violet-50 transition-colors font-medium disabled:opacity-50"
                          >
                            Resend
                          </button>

                          <button
                            onClick={() => handleCancelInvite(inv.code)}
                            disabled={!!cancellingCode}
                            className={`flex-1 text-[10px] py-1.5 rounded-lg border font-medium transition-colors flex items-center justify-center gap-1 ${
                              isCancelling
                                ? "border-slate-200 text-slate-400 bg-slate-50 cursor-wait"
                                : "border-red-200 text-red-500 hover:bg-red-50 disabled:opacity-50"
                            }`}
                          >
                            {isCancelling ? (
                              <>
                                <svg
                                  className="animate-spin h-3 w-3 text-slate-400"
                                  xmlns="http://www.w3.org/2000/svg"
                                  fill="none"
                                  viewBox="0 0 24 24"
                                >
                                  <circle
                                    className="opacity-25"
                                    cx="12"
                                    cy="12"
                                    r="10"
                                    stroke="currentColor"
                                    strokeWidth="4"
                                  />
                                  <path
                                    className="opacity-75"
                                    fill="currentColor"
                                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                                  />
                                </svg>
                                Cancelling...
                              </>
                            ) : (
                              "Cancel"
                            )}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Workspace Info */}
            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5">
              <h3 className="text-sm font-semibold text-slate-800 mb-4">
                Workspace Info
              </h3>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-slate-400">Workspace ID</p>

                    {showSkeleton ? (
                      <Skeleton height={14} width={80} className="mt-1" />
                    ) : (
                      <p className="text-sm font-mono font-bold text-violet-700">
                        {workspaceId}
                      </p>
                    )}
                  </div>

                  <button
                    onClick={copyWorkspaceId}
                    className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-700 transition-colors"
                    title="Copy workspace ID"
                  >
                    {copiedWid ? (
                      <Check size={15} className="text-emerald-500" />
                    ) : (
                      <Copy size={15} />
                    )}
                  </button>
                </div>

                <div>
                  <p className="text-xs text-slate-400">Workspace Name</p>

                  {showSkeleton ? (
                    <Skeleton height={14} width={160} className="mt-1" />
                  ) : (
                    <p className="text-sm font-medium text-slate-700">
                      {wsName}
                    </p>
                  )}
                </div>

                <div>
                  <p className="text-xs text-slate-400">Owner</p>

                  {showSkeleton ? (
                    <Skeleton height={14} width={120} className="mt-1" />
                  ) : (
                    <p className="text-sm font-medium text-slate-700">
                      {ownerMember?.displayName ||
                        ownerMember?.email ||
                        workspaceData?.ownerEmail ||
                        user?.displayName ||
                        user?.email ||
                        "Workspace owner"}
                    </p>
                  )}
                </div>

                <div>
                  <p className="text-xs text-slate-400">Workspace Users</p>

                  {showSkeleton ? (
                    <Skeleton height={14} width={140} className="mt-1" />
                  ) : (
                    <p className="text-sm font-medium text-slate-700">
                      {workspaceUserCount} /{" "}
                      {plan === "pro" ? "∞" : "10"} users{" "}
                      <span className="text-slate-400 font-normal">
                        ({plan === "pro" ? "Pro" : "Free"} plan)
                      </span>
                    </p>
                  )}
                </div>

                {!showSkeleton && plan !== "pro" && (
                  <button
                    className="w-full py-2.5 rounded-xl text-sm font-semibold text-white transition-colors"
                    style={{
                      background: "linear-gradient(135deg, #8b5cf6, #6d28d9)",
                    }}
                  >
                    ✨ Upgrade to Pro
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Invite Modal */}
      {showInvite && workspaceId && (
        <InviteMemberModal
          onClose={() => setShowInvite(false)}
          workspaceId={workspaceId}
          workspaceName={wsName}
          members={members}
          pendingInvites={pendingInvites}
        />
      )}

      {/* Toast */}
      {toast && <Toast msg={toast} onDone={() => setToast("")} />}

      <style>{`
        @keyframes slideUp {
          from { opacity: 0; transform: translateY(12px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
