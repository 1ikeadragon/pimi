import { useLocalSearchParams } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { AutomationEditorScreen } from "@/screens/automation-editor-screen";

function param(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

export default function NewAutomationRoute() {
  const params = useLocalSearchParams<{
    serverId?: string;
    template?: string;
    duplicate?: string;
    describe?: string;
  }>();
  const serverId = param(params.serverId);
  const template = param(params.template);
  const duplicate = param(params.duplicate);
  const describe = params.describe === "1";
  return (
    <HostRouteBootstrapBoundary>
      <AutomationEditorScreen
        key={`new:${serverId ?? ""}:${template ?? ""}:${duplicate ?? ""}:${describe ? "describe" : ""}`}
        mode="create"
        serverId={serverId}
        templateId={template}
        duplicateId={duplicate}
        describe={describe}
      />
    </HostRouteBootstrapBoundary>
  );
}
