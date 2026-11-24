# Profiles

Miu tests a repository only if it has a profile: one JSON file per repository in the profiles folder. On a server that folder is `/etc/miu/profiles`. Anywhere else it is `profiles/` in Miu's folder, or the folder `MIU_PROFILES` names.

The quickest way to get one: on the dashboard's **GitHub** page, press **Make a profile**. Miu reads the repository and finds the plugin's main file, the default branch and the test scripts in `composer.json` and `package.json`. Then press **Edit** beside it to add what it cannot guess. The product notes (`project.md`, below) are under **Settings → Instructions → Product notes**. Both apply from the next run, with no restart.

## A plugin

```json
{
  "repo": "acme/shop",
  "role": "main",
  "label": "Shop",
  "slug": "shop",
  "main_file": "shop.php",
  "base_branch": "main",
  "combos": ["A"],
  "read_first": ["README.md", "CONTRIBUTING.md"],
  "fast_checks": [
    { "label": "PHPUnit", "cmd": "composer test", "when": "\\.php$" },
    { "label": "Build", "cmd": "npm run build", "when": "^src/|package(-lock)?\\.json$" }
  ],
  "triage": {
    "docs_only": "^(docs/|.*\\.md$|\\.github/)",
    "ui": "^(src/|assets/)"
  },
  "built_ui": { "source": "^src/", "built": "^assets/build/" }
}
```

| Field | Meaning |
|---|---|
| `repo` | `owner/name` on GitHub. Required. |
| `role` | `main` for a plugin, `addon` for a plugin that runs on top of another (a Pro add-on), `app` for a service the plugins talk to. The default is `main`. |
| `label` | The short name the dashboard and the reports use. |
| `slug` | The plugin's folder name in `wp-content/plugins`. The default is the repository name. |
| `main_file` | The file with the `Plugin Name:` header. The default is `<slug>.php`. |
| `base_branch` | The branch the "before" site runs, and the branch pull requests merge into. |
| `combos` | Which set-ups to test. `A` is the plugin alone. The product notes say what any other combo means. |
| `read_first` | Files the agent reads before it starts: contributor guides, architecture notes, rules. |
| `fast_checks` | The repository's own tests. Miu runs them beside the agent on the pull request's code, once a changed file matches `when`. A failure is run again on the base branch, so a failure that is already there is not blamed on the pull request. |
| `triage` | Regular expressions on changed paths. `docs_only` gives a short run with no sites when every file matches it. The other keys name areas for the agent. |
| `built_ui` | For a repository that commits its built files. If a pull request changes `source` without changing `built`, the agent reports it. |
| `licence` | Optional. How to license the add-on on a test site, in words for the agent: the options to set, for example. |
| `cross_repo` | Optional. What the agent should check across repositories, in words. |
| `not_in_ci` | Optional. Things the QA machine cannot cover. The report lists them as not covered. |
| `stack` | Optional, for `role: "app"`. `{ "kind": "full" }` tests the pull request on its own test stack on the Sandbox server, `pr-hub-<n>` (a whole Hub with its admin console, renderer and a WordPress site), instead of Hubs on the QA machine. The "before" is `pr-hub-base`, one more stack that follows `dev` everywhere and is kept for good: it holds one of the 10 test-stack slots, so 9 are left for pull requests. A Free or Pro pull request that names the Hub pull request shares its stack. Miu signs its agent in to both: the seeded QA account on the app, and staff on the admin console when the pull request touches the profile's `admin` area (the Hub mails only a few staff sign-in links an hour). A profile with no `admin` area signs in to the console every time. Needs test stacks on in Settings. |

## A CI workflow as a fast check

A fast check can run one of the repository's GitHub Actions workflows instead of a command. Miu runs it with Sandbox on its own server, so the server has to be set up first ([install.md](install.md#ci-workflows-through-sandbox)).

```json
{
  "label": "CI",
  "when": "\\.php$",
  "sandbox_ci": {
    "workflow": ".github/workflows/test.yml",
    "job": "phpunit",
    "matrix": { "php": "8.3" },
    "timeout_minutes": 30
  }
}
```

| Field | Meaning |
|---|---|
| `workflow` | The workflow file, directly in `.github/workflows`. Required. |
| `job` | The job id to run. Required. |
| `matrix` | The matrix values to run, when the job has a matrix. They must pick out exactly one combination; add one fast check for each combination you want. |
| `event` | The GitHub event the run simulates. The default is `pull_request`. |
| `timeout_minutes` | The time limit, 1 to 240. The default is 30. |

The result goes in the same place as the other fast checks, and a failure is run again on the base branch. These are reported as "not run", never as a failure of the pull request: Sandbox not set up, a job that could not start or ran out of time, and a workflow that names a CI secret the base branch's same job does not name, or that the server's list (`/etc/miu/ci-secret-names`) does not give the repository. The check runs the pull request's own workflow, edited or not; what holds a job in (below) applies to whatever it says. Steps that look like a deploy or a publish are skipped. A workflow is refused, and reported as not run, if the job (or a job it needs) does not name `ubuntu-latest` or `ubuntu-22.04` in `runs-on` directly, or if its job containers or services mount folders, set Docker options other than `--health-*`, or call a reusable workflow, if the job needs another job and either one has an `if`, or if `.github` holds a symbolic link. The workflow runs on its own: Miu does not start a Sandbox WordPress site for it, because that would run the repository's own Docker setup with the server's Docker access.

## CI on every pull request

With Sandbox set up on the server, every pull request Miu tests also gets its CI, without a profile entry. Miu reads `.github/workflows` from the pull request's head, as GitHub does, so a pull request that edits its CI runs the edited jobs. The worker gets a commit of Miu's own: the pull request's tree, with the profile's sibling shipped in it. The worker never uses an `.actrc`, and drops a symbolic link at `.env`, `.vars`, `.input` or `.secrets`. A pull request chooses its jobs, not what holds them in: the worker's rules below, no Docker socket, the `runner` user and the memory and CPU caps apply to any workflow. What a job may reach comes from the tip of the profile's `base_branch`: the repositories in its token, and the CI secrets it may name (a workflow that names a secret that job on that branch does not name is not run, nor one the server's `/etc/miu/ci-secret-names` does not list for the repository). By default, each workflow that would run on GitHub for this pull request adds its jobs, one for each matrix combination. That means one triggered by `pull_request`, with its `types`, `branches` and `paths` filters applied. Failing that, one triggered by `push` with no branch or tag filter. A push to named branches or tags is a release or deploy, so it is not run. Each job runs with the same worker and the same rules as a `sandbox_ci` fast check. A job those rules refuse is listed as "not run here", with the reason, and is not run. A job that a `sandbox_ci` fast check already covers is not run twice: its result is under the repo's test suites.

CI starts when the pull request's test starts, or as soon as it is queued in auto mode. It runs beside the QA run and beside the CI of other pull requests. Two jobs run at a time by default; set `ciParallel` (1 to 8) in `runs/.config.json` to change that. The worker on the server keeps its own memory and CPU caps (`miu-ci.slice`, at a low CPU weight so the server's sites come first). A busy CPU never holds a job back: a job starts when it gets one of the worker's two slots and the server has 4 GB of memory free (the job's 2 GB plus 2 GB to spare). When the server has no room, a job waits in the line and tries again every minute, for up to two hours. Some pull requests get no CI here, and their CI runs only on GitHub. A pull request from a fork or from Dependabot is one: like GitHub, Miu does not run that code with the server's CI secrets, and the same goes for a `sandbox_ci` fast check. A workflow the worker would refuse as a whole is listed as not run. A job that another job needs runs as part of that job. A job whose own `if:` leaves it out is shown as not run here. A matrix value written as an unquoted whole number with a decimal point, such as `8.0`, cannot be picked out by Sandbox CI: write `"8.0"` to run it here. The run page's **CI** tab shows each job: its status, how long it took and its log. Secrets Miu knows are taken out of the log. Nothing is triggered on GitHub Actions. The tab links to GitHub's own checks, read only. When no workflow is for pull requests (only release, deploy or manual ones), the tab says "No PR CI in this repo". When workflows are for pull requests but their path or branch filters leave this one out, each says so.

### Choosing the workflows: `pr_ci`

Some repos run their tests only by hand (`workflow_dispatch`) or from another workflow (`workflow_call`), so the default finds nothing. For those, list in the profile what to run on every pull request:

```json
"pr_ci": [
  { "workflow": ".github/workflows/ci.yml", "jobs": ["php", "js"], "matrix": { "php": ["7.4", "8.3", "8.5"] } }
]
```

| Key | Meaning |
|---|---|
| `workflow` | A file directly in `.github/workflows`. It runs whatever its trigger is: as `pull_request` if it has that, then as `push`, then as `workflow_dispatch` (with its inputs' defaults). A workflow that is only `workflow_call`, or that runs by itself on pushes to certain branches or tags, is not run. |
| `jobs` | Optional. Only these job ids run. Leave it out for every job. A job the workflow does not have is listed as such. |
| `matrix` | Optional. Only these values of each matrix key run, to stay within the two jobs at a time. |
| `repos` | Optional. Up to 10 more repositories (`owner/name`) the run's token may read, for what Miu cannot find in the workflow. |

With a `sibling` in the profile (below), the CI run gets the sibling's source in its tar, where the base branch's workflow checks the sibling out (the checkout's `path:`, a plain folder name). It is the sibling's branch of the pull request's branch name if there is one, else `main`. A step that act leaves out with `if: ${{ !env.ACT }}` is not counted, so a workflow that skips its own download of the sibling under act needs no token for it.

A run that still reaches GitHub gets a token from the Miu App, as `GITHUB_TOKEN` (what `${{ github.token }}` reads) and as every secret the workflow uses beside `github.token` (`${{ secrets.X || github.token }}`). It reads only the repositories the job, and the jobs it needs, reach: `repository:` of `actions/checkout` (the pull request's own repository too, when named), `github.com/owner/name` URLs, `gh repo clone`, `gh api repos/...` and `gh -R` in `run:` steps, and, when a step runs Composer or npm, the GitHub repositories in `composer.json` `repositories` and in `package.json` dependencies. What it may read comes from the base branch's workflow and files, never the pull request's; a pull request that needs more is not run. A QA run's `sandbox_ci` fast check has no base branch to read, so its token reads only what the profile lists in `sandbox_ci.repos`. Only the App owner's repositories go in a token; a checkout of another owner's repository must be public. The token can only read code, lasts at most an hour and is revoked when the run ends, by Miu and by the worker. The pull request's code can read it. A run that reaches nothing gets no token. A repository the App is not installed on makes the job "not run (no access to owner/name)", as does a checkout whose repository is an expression. A dependency that the server reads with a deploy key ([install.md](install.md#a-repository-the-app-may-not-read-a-deploy-key)) needs no token: the job installs it from a copy of the server's mirror.

A repo whose tests need a database service, such as the Hub, lists the jobs that have the service in the workflow. A job that needs write access, like a security suite that posts its report on the pull request, is shown as not run, with the reason:

```json
"pr_ci": [
  { "workflow": ".github/workflows/ci.yml", "jobs": ["hub", "security", "app", "admin"] }
]
```

A `pr_ci` that names a deploy, release or notification workflow or job (below) is refused when the profile is saved, and CI says why.

With `pr_ci` set, only the listed workflows run; the default rule is off for the repo. `"pr_ci": []` runs no CI for pull requests. Leave `pr_ci` out to keep the default rule.

Listed or not, Miu runs tests only. These are never run:

- A workflow whose file name or `name` says deploy, release, publish, website-sync, announce, sync, notify, Slack, comment, summary, tag, close-issues or label. The worker refuses deploy, release, publish, website-sync, announce, Slack, tag and close-issues itself, whatever Miu asks it to run.
- A workflow triggered by `pull_request_target`, `workflow_run`, `release`, `deployment`, `issues`, `issue_comment` or `pull_request_review`, or by tag pushes.
- A job with an `environment`, or with write `permissions` (its own, or the workflow's).
- A job whose id or name has the word deploy, release, publish, website-sync, announce, notify, Slack, tag or close-issues, or that deploys to an `environment`. The worker refuses these too, for the job and every job it needs.
- A job with a step that posts (`curl -X POST`, `--data`, `--json`, a Slack hook), pushes or publishes (`git push`, `gh pr`/`gh api`, `ssh`, `rsync`, `npm publish`, `npm run deploy`, `docker push`, `aws s3 sync`, `semantic-release` and the like; a `--dry-run` line is fine), or that uses a deploy, Slack, comment, `github-script`, Codecov, Coveralls, cloud-login, auto-commit or push action.
- A job that needs any of the above.

Such a job is shown with the reason. These checks are a backstop, not the guard: the workflow is the pull request's own and can be written to get past them. The guards are the worker's rules, the CI secrets a job may name (only those the base branch's same job names and root's `/etc/miu/ci-secret-names` gives the repository, [install.md](install.md#which-ci-secrets-each-repository-may-use)) and what Sandbox's `ci_secrets` holds. Keep deploy and publish credentials out of it.

### Linked pull requests, the comment, container jobs

When a run tests pull requests together (Free, Pro and Hub), each one gets its own CI, on its own repo at its own head, with its own profile's `pr_ci`. Each result comment has a CI section: for every pull request of the run, each job's result and the commit it ran on. A failed job lists its failing tests. A job that did not run says why. If CI is still running when the comment is posted, the comment says so, and Miu edits that comment's CI section when CI finishes (or after 4 hours). It never posts a second comment.

The failing tests come from the job's own test report: a Vitest or Jest JSON report or JUnit XML, at a path the job gives to `--outputFile`, `--log-junit` or `--junitxml`. The worker adds a last step that copies them out of the job, because Sandbox keeps only the tail of a job's output. The run page's CI tab shows them, and the linked pull requests' CI as well.

A job with a `container:` runs in that image. act runs JavaScript actions (`actions/checkout`, `actions/cache`) with the image's own node, where GitHub mounts its own. When the image has none, as with `php:8.3-cli`, the worker mounts this server's node read only at `/usr/local/bin/node`, and the log says so. Container jobs get the same memory and CPU caps as other jobs.

## A plugin and its add-on

Give the add-on its own profile with `"role": "addon"`, and point each profile at the other with `sibling`:

```json
{ "repo": "acme/shop-pro", "role": "addon", "label": "Pro", "slug": "shop-pro",
  "sibling": { "repo": "acme/shop", "label": "Free", "slug": "shop" },
  "combos": ["B", "B-unlicensed", "C"], "licence": "Set the option shop_pro_license_status to valid with wp option update." }
```

Two pull requests are tested together when their branches have the same name, or when one names the other in its body (`acme/shop-pro#12`, or `Pro #12`, using the profile's `label`). The "after" site runs both pull requests and the "before" site runs both base branches. Each pull request gets its own comment and verdict.

## project.json and project.md

These files sit beside the profiles and hold what the repositories share.

```json
{
  "name": "Shop",
  "marker": "miu",
  "cloudinary_folder": "miu",
  "slack_channel": null,
  "live_hosts": ["api.shop.example", "license.shop.example"],
  "reset_dirs": ["shop-cache"],
  "reset_upload_prefix": "shop"
}
```

| Field | Meaning |
|---|---|
| `marker` | Written into every comment Miu posts, so it can find its own comments later. Keep it the same once Miu has posted. |
| `cloudinary_folder` | The Cloudinary folder for screenshots. |
| `slack_channel` | Optional. A one-line notice goes here when a report is posted. It also needs `SLACK_USER_TOKEN`. |
| `live_hosts` | Your production services. The test sites refuse to reach them and log each attempt as evidence, and the agent is told never to contact them. A licence server belongs here. |
| `reset_dirs`, `reset_upload_prefix` | What your plugin writes under `wp-content` and `wp-content/uploads`. A site reset removes them. |

`project.md` holds your product's notes, added to the end of the agent's instructions: what each combo is, the plugin's wp-cli commands, and the business rules every pull request must follow. [examples/project.md](examples/project.md) is a starting point.
