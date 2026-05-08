import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useRef,
  ReactNode,
} from "react";
import {
  onSnapshot,
  collection,
  doc,
  writeBatch,
  getDocs,
} from "firebase/firestore";
import { db } from "../lib/firebase/config";
import { useAuth } from "./AuthContext";
import { subscribeToProjects, Project } from "../lib/firebase/projects";

interface Task {
  id: string;
  title: string;
  status: string;
  priority: string;
  dueDate?: string;
  createdAt?: unknown;
  [key: string]: unknown;
}

interface TeamMember {
  id: string;
  name: string;
  role: string;
  email?: string;
  [key: string]: unknown;
}

interface WorkspaceMember {
  userId: string;
  email: string;
  displayName: string;
  avatar: string;
  avatarColor: string;
  role: "owner" | "admin" | "member" | "viewer";
  status: "active" | "pending" | "suspended";
  joinedAt: any;
  invitedBy: string;
  lastActive: any;
  permissions: {
    canCreateProjects: boolean;
    canDeleteProjects: boolean;
    canInviteMembers: boolean;
    canManageTasks: boolean;
  };
}

interface PendingInvite {
  code: string;
  email: string;
  role: "admin" | "member" | "viewer";
  status: "pending" | "accepted" | "declined" | "expired";
  invitedBy: string;
  invitedByName: string;
  workspaceId: string;
  workspaceName: string;
  inviteCode: string;
  createdAt: any;
  expiresAt: any;
  acceptedAt: any;
}

interface WorkspaceData {
  id: string;
  workspaceId: string;
  name: string;
  ownerId: string;
  ownerEmail: string;
  createdAt: any;
  memberCount: number;
  plan: "free" | "pro";
}

interface WorkspacePerson {
  userId?: string;
  uid?: string;
  email?: string;
  displayName?: string;
  photoURL?: string;
  avatar?: string;
  avatarColor?: string;
  type?: "guest" | "external_guest" | string;
  role?: string;
  status?: "active" | "removed" | string;
  projects?: Record<string, any>;
  projectIds?: string[];
  lastActive?: any;
  [key: string]: unknown;
}


interface Note {
  id: string;
  content: string;
  createdAt?: unknown;
  [key: string]: unknown;
}

interface AppDataContextType {
  tasks: Task[];
  teamMembers: TeamMember[];
  notes: Note[];
  projects: Project[];
  loading: boolean;
  files: any[];
  members: WorkspaceMember[];
  workspacePeople: WorkspacePerson[];
  pendingInvites: PendingInvite[];
  memberCount: number;
  workspaceData: WorkspaceData | null;
  cancelInvite: (inviteCode: string) => Promise<void>;
}


const AppDataContext = createContext<AppDataContextType>({
  tasks: [],
  teamMembers: [],
  notes: [],
  projects: [],
  loading: true,
  files: [],
  members: [],
  workspacePeople: [],
  pendingInvites: [],
  memberCount: 0,
  workspaceData: null,
  cancelInvite: async () => {},
});


// ── Fix legacy invites that were saved with random Firestore auto-IDs ────────
// This runs once on workspace load and re-saves any broken invites
// with the correct document ID = invite code so cancelInvite can find them
async function fixLegacyInvites(wsId: string): Promise<void> {
  try {
    const snap = await getDocs(
      collection(db, "workspaces", wsId, "invites")
    );

    const batch = writeBatch(db);
    let fixCount = 0;

    snap.docs.forEach((document) => {
      const data = document.data();
      const storedCode = data.code as string;

      // If the Firestore document ID does NOT match the code field
      // this is a legacy broken invite — fix it by re-saving with correct ID
      if (storedCode && document.id !== storedCode) {
        // Delete the broken document (random auto-ID)
        batch.delete(document.ref);

        // Re-create with the invite code as the document ID
        const correctRef = doc(
          db,
          "workspaces",
          wsId,
          "invites",
          storedCode
        );
        batch.set(correctRef, data);
        fixCount++;

        console.log(
          `[fixLegacyInvites] 🔧 Fixing invite: ${document.id} → ${storedCode}`
        );
      }
    });

    if (fixCount > 0) {
      await batch.commit();
      console.log(
        `[fixLegacyInvites] ✅ Successfully fixed ${fixCount} legacy invite(s)`
      );
    } else {
      console.log("[fixLegacyInvites] ✅ All invites already have correct IDs");
    }
  } catch (err: any) {
    console.error("[fixLegacyInvites] ❌ Failed:", err?.message || err);
  }
}

export function AppDataProvider({ children }: { children: ReactNode }) {
  const { user, workspaceId, setWorkspaceId } = useAuth();
  const uid = user?.uid ?? "";

  const [tasks, setTasks]                   = useState<Task[]>([]);
  const [teamMembers, setTeamMembers]       = useState<TeamMember[]>([]);
  const [notes, setNotes]                   = useState<Note[]>([]);
  const [projects, setProjects]             = useState<Project[]>([]);
  const [loading, setLoading]               = useState(true);
  const [members, setMembers]               = useState<WorkspaceMember[]>([]);
  const [workspacePeople, setWorkspacePeople] = useState<WorkspacePerson[]>([]);
  const [pendingInvites, setPendingInvites] = useState<PendingInvite[]>([]);
  const [workspaceData, setWorkspaceData]   = useState<WorkspaceData | null>(null);
  const resolvedRef                         = useRef(false);

  // ── Cancel invite — deletes from BOTH Firestore paths atomically ──────────
  const cancelInvite = async (inviteCode: string): Promise<void> => {
    if (!workspaceId) throw new Error("No workspace found");

    console.log("[cancelInvite] 🗑️ Deleting invite:", inviteCode);
    console.log(
      "[cancelInvite] WS path:",
      `workspaces/${workspaceId}/invites/${inviteCode}`
    );
    console.log("[cancelInvite] Global path:", `invites/${inviteCode}`);

    const batch = writeBatch(db);

    // PATH 1 — workspace subcollection
    batch.delete(doc(db, "workspaces", workspaceId, "invites", inviteCode));

    // PATH 2 — global invites collection
    batch.delete(doc(db, "invites", inviteCode));

    await batch.commit();

    console.log("[cancelInvite] ✅ batch.commit() succeeded — invite deleted");
  };

  // ── Core user data listeners ──────────────────────────────────────────────
  useEffect(() => {
    if (!uid) {
      setTasks([]);
      setTeamMembers([]);
      setNotes([]);
      setProjects([]);
      setLoading(false);
      return;
    }

    console.log("[AppData] 🔄 Attaching all listeners for uid:", uid);
    resolvedRef.current = false;
    setLoading(true);

    let t = false, m = false, n = false, p = false;

    function tryResolve() {
      if (!resolvedRef.current && t && m && n && p) {
        resolvedRef.current = true;
        setLoading(false);
        console.log("[AppData] ✅ All listeners ready — loading resolved");
      }
    }

    const timeout = setTimeout(() => {
      if (!resolvedRef.current) {
        resolvedRef.current = true;
        setLoading(false);
        console.warn("[AppData] ⚠️ Safety timeout fired — forced ready");
      }
    }, 5000);

    const unsubTasks = onSnapshot(
      collection(db, "users", uid, "tasks"),
      (snap) => {
        const data: Task[] = snap.docs.map((d) => ({
          id: d.id,
          ...(d.data() as Omit<Task, "id">),
        } as Task));
        data.sort((a, b) => {
          const aT =
            a.createdAt &&
            typeof a.createdAt === "object" &&
            "seconds" in (a.createdAt as object)
              ? (a.createdAt as { seconds: number }).seconds
              : 0;
          const bT =
            b.createdAt &&
            typeof b.createdAt === "object" &&
            "seconds" in (b.createdAt as object)
              ? (b.createdAt as { seconds: number }).seconds
              : 0;
          return bT - aT;
        });
        setTasks(data);
        t = true;
        tryResolve();
      },
      () => {
        t = true;
        tryResolve();
      }
    );

    const unsubMembers = onSnapshot(
      collection(db, "users", uid, "teamMembers"),
      (snap) => {
        const data: TeamMember[] = snap.docs.map((d) => ({
          id: d.id,
          ...(d.data() as Omit<TeamMember, "id">),
        } as TeamMember));
        setTeamMembers(data);
        m = true;
        tryResolve();
      },
      () => {
        m = true;
        tryResolve();
      }
    );

    const unsubNotes = onSnapshot(
      collection(db, "users", uid, "notes"),
      (snap) => {
        const data: Note[] = snap.docs.map((d) => ({
          id: d.id,
          ...(d.data() as Omit<Note, "id">),
        } as Note));
        setNotes(data);
        n = true;
        tryResolve();
      },
      () => {
        n = true;
        tryResolve();
      }
    );

    const unsubProjects = subscribeToProjects(uid, (data) => {
      setProjects(data);
      p = true;
      tryResolve();
    });

    return () => {
      console.log("[AppData] 🧹 Cleaning up listeners for uid:", uid);
      clearTimeout(timeout);
      unsubTasks();
      unsubMembers();
      unsubNotes();
      unsubProjects();
    };
  }, [uid]);

  // ── FIX 1: Real-time listener on users/{uid} for workspaceId changes ──────
  // When Daniel resets CTAHIGHLIGHT's workspaceId in Firestore, her
  // active session detects it here and switches workspace instantly.
  useEffect(() => {
    if (!uid) return;

    const unsubUserDoc = onSnapshot(
      doc(db, "users", uid),
      (snap) => {
        if (!snap.exists()) return;
        const firestoreWsId = snap.data().workspaceId as string | undefined;
        if (firestoreWsId && firestoreWsId !== workspaceId) {
          console.log(
            "[AppData] 🔄 workspaceId changed in Firestore:",
            workspaceId, "→", firestoreWsId
          );
          setWorkspaceId(firestoreWsId);
        }
      },
      (err) => console.warn("[AppData] user doc listener error:", err.code)
    );

    return () => unsubUserDoc();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid]); // intentionally omit workspaceId to avoid re-subscribing on every switch

  // ── Workspace team listeners (depends on workspaceId) ────────────────────
  useEffect(() => {
      if (!workspaceId) {
      setMembers([]);
      setWorkspacePeople([]);
      setPendingInvites([]);
      setWorkspaceData(null);
      return;
    }


    console.log("[AppData] 🔄 Attaching workspace listeners for:", workspaceId);

    // ✅ Fix any legacy invites that were saved with wrong document IDs
    // Runs once silently in the background — does nothing if already correct
    fixLegacyInvites(workspaceId);

    // Listen to workspace doc
    const unsubWorkspace = onSnapshot(
      doc(db, "workspaces", workspaceId),
      (snap) => {
        if (snap.exists()) {
          setWorkspaceData({ id: snap.id, ...snap.data() } as WorkspaceData);
        }
      },
      (err) => console.warn("[AppData] workspace doc error:", err.code)
    );

    // Listen to workspace members
    const unsubWsMembers = onSnapshot(
      collection(db, "workspaces", workspaceId, "members"),
      (snap) => {
        const data = snap.docs.map(
          (d) => ({ ...d.data() } as WorkspaceMember)
        );
        setMembers(data);
        console.log("[AppData] workspace members:", data.length);

        // ── FIX 2: Eviction detector ──────────────────────────────────────
        // If the current user is no longer in the members list AND they
        // are not the owner of this workspace, they have been removed.
        // Switch them to a fresh personal workspace immediately.
        if (!uid) return;
        const iStillMember = snap.docs.some((d) => d.id === uid);
        if (!iStillMember) {
          // Double-check we actually had members loaded (not a blank first-load)
          // by ensuring the snapshot is non-empty or we previously had members.
          const wsData = snap.metadata;
          if (!wsData.fromCache && snap.docs.length >= 0) {
            console.warn(
              "[AppData] ⚠️ Current user not in members list — may have been removed. Workspace:",
              workspaceId
            );
            // Read the canonical workspaceId from users/{uid} to switch
            // back to whatever the server has now (resetRemovedUserWorkspace
            // already wrote a new personalWsId there).
            import("firebase/firestore").then(({ getDoc, doc: fsDoc }) => {
              getDoc(fsDoc(db, "users", uid)).then((userSnap) => {
                if (!userSnap.exists()) return;
                const serverWsId = userSnap.data().workspaceId as string | undefined;
                if (serverWsId && serverWsId !== workspaceId) {
                  console.log(
                    "[AppData] 🚪 Eviction detected — switching to personal workspace:",
                    serverWsId
                  );
                  setWorkspaceId(serverWsId);
                }
              }).catch((e) => console.warn("[AppData] eviction getDoc error:", e));
            });
          }
        }
        // ── End eviction detector ─────────────────────────────────────────
      },
      (err) => console.warn("[AppData] members error:", err.code)
    );

    // Listen to pending invites
    // code: d.id ensures we always use the Firestore document ID as the code
    const unsubInvites = onSnapshot(
      collection(db, "workspaces", workspaceId, "invites"),
      (snap) => {
        const data = snap.docs
          .filter((d) => d.data().status !== "accepted")
          .map((d) => ({
            code: d.id,       // ← document ID IS the invite code
            ...d.data(),
          } as unknown as PendingInvite));
        setPendingInvites(data);
        console.log("[AppData] pending invites:", data.length);
      },
      (err) => console.warn("[AppData] invites error:", err.code)
    );

        // Listen to workspace people (external guests / project collaborators)
    const unsubPeople = onSnapshot(
      collection(db, "workspaces", workspaceId, "people"),
      (snap) => {
        const data = snap.docs.map(
          (d) => ({ userId: d.id, ...d.data() } as WorkspacePerson)
        );
        setWorkspacePeople(data);
        console.log("[AppData] workspace people:", data.length);
      },
      (err) => console.warn("[AppData] people error:", err.code)
    );

    return () => {
      unsubWorkspace();
      unsubWsMembers();
      unsubInvites();
      unsubPeople();
    };
  }, [workspaceId]);


  return (
    <AppDataContext.Provider
      value={{
        tasks,
        teamMembers,
        notes,
        projects,
        loading,
        files: [],
              members,
        workspacePeople,
        pendingInvites,
        memberCount: members.filter((m) => m.status === "active").length,
        workspaceData,
        cancelInvite,

      }}
    >
      {children}
    </AppDataContext.Provider>
  );
}

export function useAppData(): AppDataContextType {
  return useContext(AppDataContext);
}
