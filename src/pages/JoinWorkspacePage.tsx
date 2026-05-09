import React, { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  doc, getDoc, serverTimestamp, writeBatch,
} from "firebase/firestore";
import { db } from "../lib/firebase/config";
import { useAuth } from "../context/AuthContext";

const AVATAR_COLORS = [
  "#8b5cf6","#3b82f6","#10b981","#f59e0b",
  "#ef4444","#ec4899","#06b6d4","#84cc16",
];
function avatarColor(uid: string) {
  return AVATAR_COLORS[uid.charCodeAt(0) % AVATAR_COLORS.length];
}

type PageState = "loading" | "invalid" | "used" | "valid" | "joining" | "done";

export default function JoinWorkspacePage() {
  const { inviteCode }                 = useParams<{ inviteCode: string }>();
  const { user, loading: authLoading, setWorkspaceId } = useAuth();
  const navigate                       = useNavigate();

  const [pageState, setPageState] = useState<PageState>("loading");
  const [invite,    setInvite]    = useState<any>(null);
  const [joinError, setJoinError] = useState("");

  // ── 1. Fetch & validate invite ─────────────────────────────────────────────
  useEffect(() => {
    if (authLoading || !inviteCode) return;

    async function load() {
      try {
        const snap = await getDoc(doc(db, "invites", inviteCode!));

        if (!snap.exists()) { setPageState("invalid"); return; }

        const data = { id: snap.id, ...snap.data() } as any;

        // ✅ TYPE-GUARD — if this is a project invite, redirect to the
        // project-join page so we don't write the guest into
        // workspaces/{wsId}/members by mistake.
        if (data.type && data.type !== "workspace") {
          navigate(`/join-project/${inviteCode}`, { replace: true });
          return;
        }

        // Check expiry
        if (data.expiresAt) {
          const expMs =
            typeof data.expiresAt?.toMillis === "function"
              ? data.expiresAt.toMillis()
              : (data.expiresAt.seconds ?? 0) * 1000;
          if (expMs < Date.now()) { setPageState("invalid"); return; }
        }

        if (data.status !== "pending") { setPageState("used"); return; }

        setInvite(data);
        setPageState("valid");
      } catch (e) {
        console.error("[JoinPage] fetch error:", e);
        setPageState("invalid");
      }
    }

    load();
  }, [inviteCode, authLoading, navigate]);

  // ── 2. Accept invite ───────────────────────────────────────────────────────
  async function acceptInvite() {
    if (!user || !invite) return;
    setPageState("joining");
    setJoinError("");

    try {
      const { workspaceId, role } = invite;
      const uid = user.uid;

      const batch = writeBatch(db);

      // ✅ STEP 1 — Add user to workspace members subcollection
      const memberRef = doc(db, "workspaces", workspaceId, "members", uid);
      batch.set(memberRef, {
        userId:      uid,
        email:       user.email ?? "",
        displayName: user.displayName ?? user.email?.split("@")[0] ?? "Member",
        avatar:      (user.displayName ?? user.email ?? "M")[0].toUpperCase(),
        avatarColor: avatarColor(uid),
        role:        role ?? "member",   // ← use invited role, never "owner"
        status:      "active",
        joinedAt:    serverTimestamp(),
        invitedBy:   invite.invitedBy ?? "",
        lastActive:  serverTimestamp(),
        permissions: {
          canCreateProjects: role !== "viewer",
          canDeleteProjects: role === "admin",
          canInviteMembers:  role === "admin",
          canManageTasks:    role !== "viewer",
        },
      });

      // ✅ STEP 2 — Mark GLOBAL invite as accepted
      const globalRef = doc(db, "invites", inviteCode!);
      batch.update(globalRef, {
        status:     "accepted",
        acceptedAt: serverTimestamp(),
      });

      // ✅ STEP 3 — Mark WORKSPACE SUBCOLLECTION invite as accepted
      const wsInviteRef = doc(
        db, "workspaces", workspaceId, "invites", inviteCode!
      );
      batch.update(wsInviteRef, {
        status:     "accepted",
        acceptedAt: serverTimestamp(),
      });

      // ✅ STEP 4 — Update user doc with the SENDER's workspaceId
      const userRef = doc(db, "users", uid);
      batch.set(userRef, {
        uid,
        email:       user.email ?? "",
        displayName: user.displayName ?? user.email?.split("@")[0] ?? "Member",
        photoURL:    user.photoURL ?? "",
        plan:        "free",
        workspaceId, // ← sender's workspace, not a new one
        updatedAt:   serverTimestamp(),
      }, { merge: true });

      // ✅ Commit all 4 operations atomically
      await batch.commit();
      console.log("[JoinPage] ✅ batch.commit() succeeded");

      // ✅ STEP 5 — Update AuthContext workspaceId in memory immediately
      setWorkspaceId(workspaceId);

      // ✅ STEP 6 — Clear the pending invite code from localStorage
      localStorage.removeItem("pendingInviteCode");

      console.log("[JoinPage] ✅ Joined workspace:", workspaceId, "as:", role);
      setPageState("done");
      setTimeout(() => navigate("/"), 1600);

    } catch (e: any) {
      console.error("[JoinPage] accept error:", e);
      setJoinError("Failed to join workspace. Please try again.");
      setPageState("valid");
    }
  }

  function storeAndGo(path: string) {
    if (inviteCode) localStorage.setItem("pendingInviteCode", inviteCode);
    navigate(path);
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-gradient-to-br from-violet-600 to-violet-900 flex items-center justify-center p-4">
      <div className="bg-white rounded-3xl shadow-2xl p-8 w-full max-w-md">

        {/* Logo */}
        <div className="flex items-center justify-center gap-2.5 mb-7">
          <div className="w-9 h-9 bg-violet-600 rounded-xl flex items-center justify-center shadow-lg">
            <span className="text-white font-extrabold text-sm">W</span>
          </div>
          <span className="text-2xl tracking-tight">
            <span className="font-extrabold text-slate-900">Wurk</span>
            <span className="font-light text-slate-900">fine</span>
          </span>
        </div>

        {/* ── Loading ── */}
        {(pageState === "loading" || authLoading) && (
          <div className="text-center py-10">
            <div className="w-10 h-10 border-4 border-violet-200 border-t-violet-600 rounded-full animate-spin mx-auto mb-4" />
            <p className="text-sm text-slate-500">Verifying your invitation...</p>
          </div>
        )}

        {/* ── Invalid / expired ── */}
        {pageState === "invalid" && (
          <div className="text-center py-4">
            <div className="w-14 h-14 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4 text-3xl">❌</div>
            <h2 className="text-lg font-bold text-slate-800 mb-2">Invalid or Expired Link</h2>
            <p className="text-sm text-slate-500 mb-1">This invite link is invalid or has expired.</p>
            <p className="text-xs text-slate-400 mb-6">
              Please ask your workspace admin to send a new invitation.
            </p>
            <button
              onClick={() => navigate("/login")}
              className="w-full py-2.5 bg-violet-600 text-white rounded-xl text-sm font-semibold hover:bg-violet-700 transition-colors"
            >
              Go to Login
            </button>
          </div>
        )}

        {/* ── Already used / revoked ── */}
        {pageState === "used" && (
          <div className="text-center py-4">
            <div className="w-14 h-14 bg-amber-100 rounded-full flex items-center justify-center mx-auto mb-4 text-3xl">⚠️</div>
            <h2 className="text-lg font-bold text-slate-800 mb-2">Invite Already Used</h2>
            <p className="text-sm text-slate-500 mb-6">
              This invite has already been accepted or revoked. Please ask your admin for a new one.
            </p>
            <button
              onClick={() => navigate("/login")}
              className="w-full py-2.5 bg-violet-600 text-white rounded-xl text-sm font-semibold hover:bg-violet-700 transition-colors"
            >
              Go to Login
            </button>
          </div>
        )}

        {/* ── Valid invite ── */}
        {(pageState === "valid" || pageState === "joining") && invite && (
          <div>
            <div className="text-center mb-6">
              <div className="text-4xl mb-3">🎉</div>
              <h2 className="text-xl font-bold text-slate-800 mb-1">You've been invited!</h2>
              <p className="text-sm text-slate-500">
                <span className="font-semibold text-slate-700">{invite.invitedByName}</span> invited
                you to join the{" "}
                <span className="font-semibold text-violet-700">{invite.workspaceId}</span> workspace
                as a <span className="font-semibold text-slate-700 capitalize">{invite.role}</span>.
              </p>
            </div>

            {/* Info card */}
            <div className="bg-slate-50 rounded-2xl p-4 mb-5 space-y-2.5">
              <Row label="Workspace"  value={invite.workspaceName || invite.workspaceId} />
              <Row label="Your Role"  value={<span className="capitalize">{invite.role}</span>} />
              <Row label="Invited by" value={invite.invitedByName} />
            </div>

            {invite.message && (
              <p className="text-sm italic text-slate-500 bg-slate-50 rounded-xl p-3 mb-4 text-center">
                "{invite.message}"
              </p>
            )}

            {joinError && (
              <p className="text-xs text-red-500 text-center mb-3">{joinError}</p>
            )}

            {/* Not signed in */}
            {!user ? (
              <div className="flex flex-col gap-3">
                <button
                  onClick={() => storeAndGo("/login")}
                  className="w-full py-3 bg-violet-600 text-white rounded-xl text-sm font-semibold hover:bg-violet-700 transition-colors"
                >
                  Sign In to Accept
                </button>
                <button
                  onClick={() => storeAndGo("/login")}
                  className="w-full py-3 border border-violet-300 text-violet-700 rounded-xl text-sm font-semibold hover:bg-violet-50 transition-colors"
                >
                  Create Account
                </button>
              </div>
            ) : (
              <button
                onClick={acceptInvite}
                disabled={pageState === "joining"}
                className="w-full py-3 bg-violet-600 text-white rounded-xl text-sm font-semibold hover:bg-violet-700 transition-colors disabled:opacity-60 flex items-center justify-center gap-2"
              >
                {pageState === "joining" ? (
                  <>
                    <div className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                    Joining workspace...
                  </>
                ) : (
                  "Accept Invitation →"
                )}
              </button>
            )}
          </div>
        )}

        {/* ── Done ── */}
        {pageState === "done" && (
          <div className="text-center py-6">
            <div className="w-16 h-16 bg-emerald-100 rounded-full flex items-center justify-center mx-auto mb-4 text-3xl">✅</div>
            <h2 className="text-xl font-bold text-slate-800 mb-1">Welcome to the team!</h2>
            <p className="text-sm text-slate-400">Redirecting to your dashboard...</p>
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between items-center text-sm">
      <span className="text-slate-400">{label}</span>
      <span className="font-medium text-slate-700">{value}</span>
    </div>
  );
}
