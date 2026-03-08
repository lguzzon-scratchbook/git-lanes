---
name: are-init
description: Initialize agents-reverse-engineer configuration
disable-model-invocation: true
---

Initialize agents-reverse-engineer configuration in this project.

<execution>
1. **Read version**: Read `.claude/ARE-VERSION` → store as `$VERSION`. Show the user: `agents-reverse-engineer v$VERSION`

2. Run the agents-reverse-engineer init command:

```bash
npx agents-reverse-engineer@$VERSION init
```

This creates `.agents-reverse-engineer/config.yaml` configuration file.
</execution>
