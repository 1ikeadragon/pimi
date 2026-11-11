import { useEffect, useState } from "react";
import { openAutomationForm, type AutomationFormSnapshot } from "./automation-form-model";

export function useAutomationFormModel(snapshot: AutomationFormSnapshot) {
  const [model] = useState(() => openAutomationForm(snapshot));

  useEffect(() => {
    return () => {
      model.close();
    };
  }, [model]);

  useEffect(() => {
    model.applyHosts(snapshot.hosts);
    model.applyProjectTargets(snapshot.defaults.projectTargets);
    model.applyPreferences(snapshot.defaults.preferences);
  }, [model, snapshot.hosts, snapshot.defaults.preferences, snapshot.defaults.projectTargets]);

  return model;
}
