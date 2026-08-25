"use client";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import styles from "./file-library.module.css";
import { FileReviewComments } from "./file-review-comments";
import { buildFileReviewContext, fileFamilyCommentThread } from "./file-review-model";
import { FileReviewOverview } from "./file-review-overview";
import type { FileReviewBodyProps, FileReviewDrawerProps } from "./file-review-types";
import { FileReviewVersions } from "./file-review-versions";

export function FileReviewDrawerBody({
  family,
  asset,
  sessions,
  tasks,
  profiles,
  history,
  comments,
  loading,
  busy,
  assetHistoryError,
  commentsError,
  reviewAvailable,
  onSelectVersion,
  onDownload,
  onAddComment,
  onReview,
}: FileReviewBodyProps) {
  if (family === undefined) {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          The selected private file is no longer present in this event projection.
        </AlertDescription>
      </Alert>
    );
  }

  const context = buildFileReviewContext(family, asset, history, sessions, tasks, profiles);
  const threadCount = fileFamilyCommentThread(comments, context.versions).length;

  return (
    <Tabs defaultValue="overview" className={styles.drawerTabs}>
      <TabsList variant="line" aria-label="File review sections">
        <TabsTrigger value="overview">Overview</TabsTrigger>
        <TabsTrigger value="comments">
          Comments{threadCount === 0 ? "" : ` (${threadCount})`}
        </TabsTrigger>
        <TabsTrigger value="versions">Versions ({context.versions.length})</TabsTrigger>
      </TabsList>

      <TabsContent value="overview">
        <FileReviewOverview
          context={context}
          busy={busy}
          reviewAvailable={reviewAvailable}
          {...(onDownload === undefined ? {} : { onDownload })}
          {...(onReview === undefined ? {} : { onReview })}
        />
      </TabsContent>

      <TabsContent value="comments">
        <FileReviewComments
          context={context}
          comments={comments}
          loading={loading}
          busy={busy}
          error={commentsError}
          {...(onAddComment === undefined ? {} : { onAddComment })}
        />
      </TabsContent>

      <TabsContent value="versions">
        <FileReviewVersions
          context={context}
          loading={loading}
          busy={busy}
          error={assetHistoryError}
          {...(onSelectVersion === undefined ? {} : { onSelectVersion })}
          {...(onDownload === undefined ? {} : { onDownload })}
        />
      </TabsContent>
    </Tabs>
  );
}

export function FileReviewDrawer({ open, onOpenChange, ...bodyProps }: FileReviewDrawerProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className={styles.drawer}>
        <SheetHeader className={styles.drawerHeader}>
          <SheetTitle>File review</SheetTitle>
          <SheetDescription>
            Review metadata, file-family comments, and immutable version history.
          </SheetDescription>
        </SheetHeader>
        <ScrollArea className={styles.drawerScroll}>
          <div className={styles.drawerBody}>
            <FileReviewDrawerBody {...bodyProps} />
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
