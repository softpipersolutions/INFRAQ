"use client";

import { useState } from "react";
import { USER_ROLES, type UserRole } from "@pebble/shared";
import { Badge, Button, Card, EmptyState, PageHeader, Select } from "@/components/ui";
import { trpc } from "@/trpc/react";

function roleTone(role: string): "red" | "blue" | "green" {
  switch (role) {
    case "admin":
      return "red";
    case "approver":
      return "green";
    default:
      return "blue";
  }
}

export default function UsersPage() {
  const users = trpc.users.list.useQuery();
  const utils = trpc.useUtils();
  const setRole = trpc.users.setRole.useMutation();

  // Pending (unsaved) role picks keyed by uid; Save clears the entry.
  const [pending, setPending] = useState<Record<string, UserRole>>({});
  const [msg, setMsg] = useState<string | null>(null);

  async function onSave(firebaseUid: string) {
    const role = pending[firebaseUid];
    if (!role) return;
    setMsg(null);
    try {
      await setRole.mutateAsync({ firebaseUid, role });
      setPending((prev) => {
        const next = { ...prev };
        delete next[firebaseUid];
        return next;
      });
      setMsg("Role updated.");
      await utils.users.list.invalidate();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Update failed");
    }
  }

  return (
    <div>
      <PageHeader
        title="Users & roles"
        subtitle="Google-authenticated users. New sign-ins are provisioned as estimator; promote here."
      />

      {users.isError ? (
        <EmptyState>Failed to load users: {users.error.message}</EmptyState>
      ) : !users.data ? (
        <EmptyState>Loading…</EmptyState>
      ) : (
        <Card className="overflow-hidden">
          <div className="flex items-center justify-between border-b border-[var(--pebble-border)] px-4 py-2">
            <span className="text-sm font-semibold">Users ({users.data.length})</span>
            {msg ? <span className="text-xs text-[var(--pebble-muted)]">{msg}</span> : null}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--pebble-border)] text-left text-xs uppercase tracking-wide text-[var(--pebble-muted)]">
                  <th className="px-3 py-2">Email</th>
                  <th className="px-3 py-2">Name</th>
                  <th className="px-3 py-2">Role</th>
                  <th className="px-3 py-2">Active</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {users.data.map((u) => (
                  <tr key={u.firebaseUid} className="border-b border-[var(--pebble-border)] last:border-0">
                    <td className="px-3 py-2">{u.email}</td>
                    <td className="px-3 py-2">{u.displayName}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <Select
                          className="w-36"
                          value={pending[u.firebaseUid] ?? u.role}
                          onChange={(e) =>
                            setPending((prev) => ({
                              ...prev,
                              [u.firebaseUid]: e.target.value as UserRole,
                            }))
                          }
                        >
                          {USER_ROLES.map((r) => (
                            <option key={r} value={r}>
                              {r}
                            </option>
                          ))}
                        </Select>
                        <Badge tone={roleTone(u.role)}>{u.role}</Badge>
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <Badge tone={u.active ? "green" : "neutral"}>{u.active ? "active" : "inactive"}</Badge>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Button
                        disabled={!pending[u.firebaseUid] || pending[u.firebaseUid] === u.role || setRole.isPending}
                        onClick={() => onSave(u.firebaseUid)}
                      >
                        Save
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
