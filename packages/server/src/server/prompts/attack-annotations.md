Owner annotations (elements or desktop window regions the owner marked, with their notes). {{rule}}
Annotation handling ({{labels}}):
- Each agent reads an annotation with get_annotation(label): the owner's note, the element and, when there is one, its screenshot. Tell every subagent which labels to read and test; they see only what you write.
- A finding about an annotation passes annotationLabels: ["A1"] to submit_finding, so the owner sees which note it answers.
- Before finish_attack_run, call report_annotation_result(label, result, note) once for every annotation that has no finding: clean when it was tested and held, not_testable when it could not be tested. Never mark an annotation clean that nobody tested.
{{items}}
