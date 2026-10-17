import { IconPlus, IconRobot, IconUser } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Fragment, useId, useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { ui } from "@/lib/i18n";
import {
  createMemoryMutationOptions,
  deleteMemoryMutationOptions,
  type MemoryRecord,
  memoriesQueryOptions,
  updateMemoryMutationOptions,
} from "@/lib/memory";
import { queryClient } from "@/query-client";

/**
 * A fact the person tells their Bots directly. It reaches every one of them.
 *
 * The page's one primary verb, so it is a button for `PageShell`'s `action` that opens a dialog,
 * rather than a form standing above the list somebody came to read.
 */
export function RememberFact() {
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState("");
  const formId = useId();
  const remember = useMutation(createMemoryMutationOptions(queryClient));
  return (
    <>
      <Button
        onClick={() => {
          // Opening starts clean: no draft or failure left from an earlier attempt.
          setContent("");
          remember.reset();
          setOpen(true);
        }}
        size="sm"
        variant="ghost"
      >
        <IconPlus />
        {ui.settings.memory.remember}
      </Button>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{ui.settings.memory.remember}</DialogTitle>
            <DialogDescription>
              {ui.settings.memory.rememberDescription}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="mt-4">
            {/* The submit button is in the footer and reaches this form by id, so DialogBody stays a
                direct child of DialogContent and keeps scrolling. */}
            <form
              id={formId}
              onSubmit={(event) => {
                event.preventDefault();
                remember.mutate(content, {
                  onSuccess: () => {
                    setContent("");
                    setOpen(false);
                  },
                });
              }}
            >
              <Field>
                <FieldLabel htmlFor={`${formId}-content`}>
                  {ui.settings.memory.field}
                </FieldLabel>
                <Textarea
                  id={`${formId}-content`}
                  required
                  maxLength={6000}
                  value={content}
                  onChange={(event) => setContent(event.target.value)}
                  placeholder={ui.settings.memory.placeholder}
                />
              </Field>
            </form>
            {remember.error ? (
              <p role="alert" className="text-destructive text-sm">
                {remember.error.message}
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter className="mt-4">
            <Button onClick={() => setOpen(false)} size="sm" variant="outline">
              {ui.settings.cancel}
            </Button>
            <Button
              disabled={remember.isPending || !content.trim()}
              form={formId}
              size="sm"
              type="submit"
            >
              {ui.settings.memory.submit}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Everything the person's Bots remember about them, with who formed each memory. */
export function MemoryList() {
  const memories = useQuery(memoriesQueryOptions());
  const agents = useQuery(agentListQueryOptions());
  const botName = (id: string | null) =>
    agents.data?.find((agent) => agent.id === id)?.name ??
    ui.settings.memory.yourBot;
  return (
    <PageSection title={ui.settings.memory.yours}>
      {memories.isPending ? null : memories.error ? (
        <p role="alert" className="mt-4 text-destructive text-sm">
          {memories.error.message}
        </p>
      ) : memories.data.length ? (
        <PageRows>
          {memories.data.map((memory, index) => (
            <Fragment key={memory.id}>
              {index > 0 ? <Separator /> : null}
              <MemoryRow
                botName={botName(memory.formedByAgentId)}
                memory={memory}
              />
            </Fragment>
          ))}
        </PageRows>
      ) : (
        <PageEmpty>{ui.settings.memory.empty}</PageEmpty>
      )}
    </PageSection>
  );
}

/**
 * One memory: the fact itself, then where it came from. Whether Bots use it is a switch; editing
 * its words opens a dialog, and confirming or forgetting it are the buttons beneath.
 */
function MemoryRow({
  memory,
  botName,
}: {
  memory: MemoryRecord;
  botName: string;
}) {
  const [editing, setEditing] = useState(false);
  const save = useMutation(updateMemoryMutationOptions(queryClient));
  const forget = useMutation(deleteMemoryMutationOptions(queryClient));
  const update = (input: {
    content?: string;
    enabled?: boolean;
    reviewState?: "confirmed";
  }) => save.mutate({ id: memory.id, input });
  // Intelligence keeps only the words of a memory it holds for this person, so it can be edited or
  // forgotten here but not paused or reviewed.
  const heldByIntelligence = memory.formedBy === "intelligence";
  const status = heldByIntelligence
    ? ui.settings.memory.keptInIntelligence
    : !memory.enabled
      ? ui.settings.memory.disabled
      : memory.formedBy === "bot"
        ? ui.settings.memory.formedBy(
            botName,
            memory.reviewState === "unreviewed",
          )
        : memory.reviewState === "unreviewed"
          ? ui.settings.memory.imported
          : ui.settings.memory.reviewed;
  return (
    <Item size="sm">
      <ItemMedia variant="icon">
        {memory.formedBy === "bot" ? <IconRobot /> : <IconUser />}
      </ItemMedia>
      <ItemContent>
        <ItemTitle className="line-clamp-none whitespace-pre-wrap">
          {memory.content}
        </ItemTitle>
        <ItemDescription className="line-clamp-none">
          {memory.provenance} · {status}
        </ItemDescription>
        {memory.formedBy === "bot" && (
          <ItemDescription className="line-clamp-none">
            {ui.settings.memory.from(
              memory.sourceApp ?? ui.settings.memory.aConversation,
            )}
            {memory.observedAt
              ? ui.settings.memory.read(
                  new Date(memory.observedAt).toLocaleString("fr-FR"),
                )
              : ""}
            {memory.sourceLink && (
              <>
                {" · "}
                <a href={memory.sourceLink} target="_blank" rel="noreferrer">
                  {ui.settings.memory.openRecord}
                </a>
              </>
            )}
          </ItemDescription>
        )}
        {/* A set, so it wraps onto its own line rather than crowding the fact. */}
        <ItemFooter>
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => {
                save.reset();
                setEditing(true);
              }}
              size="sm"
              variant="outline"
            >
              {ui.settings.memory.edit}
            </Button>
            {memory.reviewState === "unreviewed" && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => update({ reviewState: "confirmed" })}
              >
                {ui.settings.memory.confirm}
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              disabled={forget.isPending}
              onClick={() => forget.mutate(memory.id)}
            >
              {ui.settings.memory.forget}
            </Button>
          </div>
        </ItemFooter>
        {!editing && (save.error || forget.error) && (
          <p role="alert" className="text-destructive text-sm">
            {save.error?.message || forget.error?.message}
          </p>
        )}
      </ItemContent>
      {heldByIntelligence ? null : (
        <ItemActions>
          {/* Binary and immediate: Bots stop or start using it when switched. */}
          <Switch
            aria-label={ui.settings.memory.use(clip(memory.content))}
            checked={memory.enabled}
            disabled={save.isPending}
            onCheckedChange={(enabled) => update({ enabled })}
          />
        </ItemActions>
      )}
      {editing ? (
        <EditMemoryDialog
          memory={memory}
          onClose={() => setEditing(false)}
          onSave={(content) =>
            save.mutate(
              { id: memory.id, input: { content } },
              { onSuccess: () => setEditing(false) },
            )
          }
          error={save.error?.message ?? null}
          saving={save.isPending}
        />
      ) : null}
    </Item>
  );
}

/** A memory's words, cut short enough to name the switch beside them. */
function clip(content: string) {
  const line = content.replace(/\s+/g, " ").trim();
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

/** The memory's words in a dialog. Saving rewrites them; the server records it as edited. */
function EditMemoryDialog({
  memory,
  saving,
  error,
  onSave,
  onClose,
}: {
  memory: MemoryRecord;
  saving: boolean;
  error: string | null;
  onSave: (content: string) => void;
  onClose: () => void;
}) {
  const [content, setContent] = useState(memory.content);
  const id = useId();
  return (
    <Dialog onOpenChange={(next) => !next && onClose()} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{ui.settings.memory.editTitle}</DialogTitle>
          <DialogDescription>{memory.provenance}</DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4">
          <Field>
            <FieldLabel className="sr-only" htmlFor={id}>
              {ui.settings.memory.fieldLabel}
            </FieldLabel>
            <Textarea
              autoFocus
              id={id}
              maxLength={6000}
              onChange={(event) => setContent(event.target.value)}
              rows={5}
              value={content}
            />
          </Field>
          {error ? (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button onClick={onClose} size="sm" variant="outline">
            {ui.settings.cancel}
          </Button>
          <Button
            disabled={saving || !content.trim()}
            onClick={() => onSave(content)}
            size="sm"
          >
            {ui.settings.save}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
