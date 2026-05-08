/**
 * Cloud Functions for Workfine.
 *
 * cleanupGuestsOnProjectDelete:
 *   When a project is deleted, remove that project from every external
 *   guest record in the workspace`s /people collection. If a guest record
 *   ends up with zero remaining projects, delete the guest record entirely
 *   so they do not pollute the External Guests list with dead access.
 *
 * Lazy initialization pattern:
 *   The Admin SDK is initialized inside the handler, not at module top
 *   level. This avoids the Firebase deploy analyzer timing out while
 *   resolving Application Default Credentials during introspection.
 */

import { onDocumentDeleted } from "firebase-functions/v2/firestore";
import { logger } from "firebase-functions/v2";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

function getDb() {
  if (getApps().length === 0) {
    initializeApp();
  }
  return getFirestore();
}

export const cleanupGuestsOnProjectDelete = onDocumentDeleted(
  {
    document: "projects/{projectId}",
    region: "us-central1",
  },
  async (event) => {
    const db = getDb();
    const projectId = event.params.projectId;
    const before = event.data?.data();

    if (!before) {
      logger.warn("[cleanupGuests] No before-data for deleted project", {
        projectId,
      });
      return;
    }

    const workspaceId: string | undefined = before.workspaceId;
    if (!workspaceId || typeof workspaceId !== "string") {
      logger.warn("[cleanupGuests] Deleted project has no workspaceId, skipping", {
        projectId,
      });
      return;
    }

    logger.info("[cleanupGuests] Project deleted, scanning guests", {
      projectId,
      workspaceId,
    });

    const peopleRef = db.collection(`workspaces/${workspaceId}/people`);
    const affectedSnap = await peopleRef
      .where("projectIds", "array-contains", projectId)
      .get();

    if (affectedSnap.empty) {
      logger.info("[cleanupGuests] No guests reference this project", {
        projectId,
        workspaceId,
      });
      return;
    }

    const batch = db.batch();
    let updatedCount = 0;
    let deletedCount = 0;

    for (const personDoc of affectedSnap.docs) {
      const data = personDoc.data();
      const currentPids: string[] = Array.isArray(data.projectIds)
        ? data.projectIds
        : [];
      const remainingPids = currentPids.filter((p) => p !== projectId);

      if (remainingPids.length === 0) {
        batch.delete(personDoc.ref);
        deletedCount++;
        logger.info("[cleanupGuests] Deleting orphan guest", {
          uid: personDoc.id,
          email: data.email,
          workspaceId,
        });
      } else {
        batch.update(personDoc.ref, {
          projectIds: FieldValue.arrayRemove(projectId),
          [`projects.${projectId}`]: FieldValue.delete(),
          updatedAt: FieldValue.serverTimestamp(),
        });
        updatedCount++;
        logger.info("[cleanupGuests] Removing project from guest", {
          uid: personDoc.id,
          email: data.email,
          remainingProjectCount: remainingPids.length,
        });
      }
    }

    await batch.commit();

    logger.info("[cleanupGuests] Done", {
      projectId,
      workspaceId,
      guestsUpdated: updatedCount,
      guestsDeleted: deletedCount,
    });
  }
);
