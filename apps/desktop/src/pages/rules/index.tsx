import AddRoundedIcon from "@mui/icons-material/AddRounded";
import DeleteRoundedIcon from "@mui/icons-material/DeleteRounded";
import {
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  IconButton,
  InputLabel,
  MenuItem,
  OutlinedInput,
  Select,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from "@mui/material";
import type { BreakpointRule, BreakpointStage } from "@pharles/shared-types";
import { useState } from "react";

import { SectionCard } from "@/components/shared/SectionCard";
import { useBreakpointRules, useSetBreakpointRules } from "@/features/breakpoints/use-breakpoint-rules";

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

function createEmptyRule(): BreakpointRule {
  return {
    id: crypto.randomUUID(),
    enabled: true,
    urlPattern: "",
    methods: [],
    stage: "request",
  };
}

export function RulesPage() {
  const { data: rules = [] } = useBreakpointRules();
  const setRulesMutation = useSetBreakpointRules();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [draft, setDraft] = useState<BreakpointRule>(createEmptyRule());

  function handleSave() {
    setRulesMutation.mutate([...rules, draft]);
    setDialogOpen(false);
    setDraft(createEmptyRule());
  }

  function handleToggle(id: string) {
    setRulesMutation.mutate(rules.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r)));
  }

  function handleDelete(id: string) {
    setRulesMutation.mutate(rules.filter((r) => r.id !== id));
  }

  function handleAddCatchAll(stage: BreakpointStage) {
    const catchAll: BreakpointRule = {
      id: crypto.randomUUID(),
      enabled: true,
      urlPattern: "*",
      methods: [],
      stage,
    };
    setRulesMutation.mutate([...rules, catchAll]);
  }

  const hasRequestCatchAll = rules.some((r) => r.enabled && r.urlPattern === "*" && r.stage === "request" && r.methods.length === 0);
  const hasResponseCatchAll = rules.some((r) => r.enabled && r.urlPattern === "*" && r.stage === "response" && r.methods.length === 0);

  return (
    <Stack spacing={3}>
      <Stack spacing={0.75}>
        <Typography variant="h4">Rules</Typography>
        <Typography color="text.secondary" variant="body1">
          Manage breakpoints and request/response interception rules.
        </Typography>
      </Stack>

      {/* Quick actions */}
      <SectionCard title="Quick Breakpoint" description="Enable catch-all breakpoints to intercept every request or response.">
        <Stack direction="row" spacing={1.5}>
          <Button
            variant="outlined"
            size="small"
            disabled={hasRequestCatchAll}
            onClick={() => handleAddCatchAll("request")}
          >
            Break on All Requests
          </Button>
          <Button
            variant="outlined"
            size="small"
            disabled={hasResponseCatchAll}
            onClick={() => handleAddCatchAll("response")}
          >
            Break on All Responses
          </Button>
        </Stack>
      </SectionCard>

      {/* Rule list */}
      <SectionCard title="Breakpoint Rules" description="Rules are evaluated in order. The first matching rule triggers the breakpoint.">
        {rules.length === 0 ? (
          <Typography color="text.secondary" variant="body2" sx={{ py: 1 }}>
            No rules defined. Add a rule or use the quick actions above.
          </Typography>
        ) : (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell sx={{ width: 56 }}>On</TableCell>
                <TableCell>URL Pattern</TableCell>
                <TableCell sx={{ width: 180 }}>Methods</TableCell>
                <TableCell sx={{ width: 100 }}>Stage</TableCell>
                <TableCell sx={{ width: 48 }} />
              </TableRow>
            </TableHead>
            <TableBody>
              {rules.map((rule) => (
                <TableRow key={rule.id}>
                  <TableCell>
                    <Switch size="small" checked={rule.enabled} onChange={() => handleToggle(rule.id)} />
                  </TableCell>
                  <TableCell>
                    <Typography sx={{ fontFamily: "JetBrains Mono, Consolas, monospace", fontSize: 13 }}>
                      {rule.urlPattern || "*"}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    {rule.methods.length === 0 ? (
                      <Chip label="ALL" size="small" variant="outlined" sx={{ fontSize: 11 }} />
                    ) : (
                      <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                        {rule.methods.map((m) => (
                          <Chip key={m} label={m} size="small" sx={{ fontSize: 10 }} />
                        ))}
                      </Stack>
                    )}
                  </TableCell>
                  <TableCell>
                    <Chip
                      label={rule.stage}
                      size="small"
                      color={rule.stage === "request" ? "info" : "secondary"}
                      variant="outlined"
                      sx={{ fontSize: 11, textTransform: "capitalize" }}
                    />
                  </TableCell>
                  <TableCell>
                    <IconButton size="small" color="error" onClick={() => handleDelete(rule.id)}>
                      <DeleteRoundedIcon fontSize="small" />
                    </IconButton>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </SectionCard>

      {/* Add rule button */}
      <Box>
        <Button
          variant="contained"
          startIcon={<AddRoundedIcon />}
          onClick={() => {
            setDraft(createEmptyRule());
            setDialogOpen(true);
          }}
        >
          Add Rule
        </Button>
      </Box>

      {/* Add rule dialog */}
      <Dialog fullWidth maxWidth="sm" onClose={() => setDialogOpen(false)} open={dialogOpen}>
        <DialogTitle>Add Breakpoint Rule</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 0.5 }}>
            <OutlinedInput
              placeholder="URL pattern (substring match, e.g. api.example.com or *)"
              value={draft.urlPattern}
              onChange={(e) => setDraft({ ...draft, urlPattern: e.target.value })}
              fullWidth
              sx={{ fontFamily: "JetBrains Mono, Consolas, monospace", fontSize: 13 }}
            />
            <FormControl size="small" fullWidth>
              <InputLabel>HTTP Methods</InputLabel>
              <Select
                multiple
                value={draft.methods}
                onChange={(e) => setDraft({ ...draft, methods: e.target.value as string[] })}
                input={<OutlinedInput label="HTTP Methods" />}
                renderValue={(selected) => (selected.length === 0 ? "All methods" : selected.join(", "))}
              >
                {HTTP_METHODS.map((m) => (
                  <MenuItem key={m} value={m}>
                    {m}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <FormControl size="small" fullWidth>
              <InputLabel>Stage</InputLabel>
              <Select
                value={draft.stage}
                label="Stage"
                onChange={(e) => setDraft({ ...draft, stage: e.target.value as BreakpointStage })}
              >
                <MenuItem value="request">Request (before forwarding)</MenuItem>
                <MenuItem value="response">Response (before returning to client)</MenuItem>
              </Select>
            </FormControl>
          </Stack>
        </DialogContent>
        <Divider />
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setDialogOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            onClick={handleSave}
            disabled={setRulesMutation.isPending}
          >
            Add Rule
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
