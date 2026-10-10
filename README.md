# effort-fit

> **실험작(Experimental).** 개인 실험으로 만든 Claude Code 플러그인입니다. Claude Code 2.1.295(Windows)에서만 확인했고, 기반이 되는 플러그인 훅 API는 Claude Code 쪽에서 "early access"로 표시돼 있어 다음 버전에서 동작이 깨질 수 있습니다. 판정 기준은 소수의 시험 턴으로 정한 경험칙이며 검증된 지표가 아닙니다.
>
> *Experimental Claude Code plugin that shows whether the session's model and reasoning effort fit the current work. Tested only on Claude Code 2.1.295 (Windows); it relies on an early-access hooks API and may break on later versions.*

사용자가 처음 고른 모델·effort에서 출발해, 턴이 끝날 때마다 최근 사용 패턴에 지금 조합이 맞는지 판정하고 맞는 모델·effort를 프롬프트 위 패널과 상태줄에 보여 줍니다. 한 칸씩이 아니라 패턴에 맞는 조합을 바로 추천합니다(예: Haiku·medium에서 실패가 쌓이면 Fable·high). **패널은 정보만 보여 줍니다. 모델이나 effort를 바꾸지 않고 바꾸는 명령도 띄우지 않습니다. 바꿀지는 사용자가 정하고 직접 바꿉니다.**

```
요구 수준 ■■■■ 매우 무거움 · 최근 2턴에 반복 실패·수정 후 실패 3회 · 분류 heavy
지금 Haiku 5.5·medium: 부족 → 매우 무거움용 조합 권장
추천 Fable·high · 모델 전환 · 약 57k 토큰을 캐시 없이 다시 읽음
대안 Opus·max · 모델 전환 · 약 57k 토큰을 캐시 없이 다시 읽음
캐시가 깨지는 변경은 다음 compaction 직후에 하면 손실이 없습니다.
```

상태줄은 `Haiku 5.5·medium ▲ Fable·high 권장 (요구 매우 무거움)`이나 `Opus 5.5·high ● 적합, 유지 (요구 무거움)`처럼 한 줄로 보여 줍니다. 패널은 "숨기기"로 가릴 수 있고, 추천이 바뀌면 다시 나타납니다.

## 판정 규칙

결정론적 신호가 중심이고, 로컬 LLM 분류는 보조입니다. 요구 수준은 최근 5턴(메인 대화)으로 매깁니다.

| 요구 수준 | 조건 | 추천 | 대안 |
|---|---|---|---|
| 매우 무거움 | 반복 실패·수정 후 실패가 3회 이상 | Fable·high | Opus·max |
| 무거움 | 반복 실패·수정 후 실패 1회 이상, 또는 큰 작업 턴(10단계 이상이나 편집 3회 이상) 2회 이상, 또는 분류 heavy에 큰 작업 턴 1회 | Opus·xhigh | Opus·high |
| 가벼움 | 창 안의 턴이 모두 가벼운 턴(4단계 이하·편집 1회 이하·오류 0·읽기 전용 도구만)이고 3턴 이상(분류 light면 2턴, heavy면 해당 없음) | Haiku·medium | Sonnet·low |
| 보통 | 그 밖 | Sonnet·high | Opus·medium |

- 지금 조합이 맡는 수준은 `hooks/judge.ts`의 `TIER` 표로 정합니다. 요구 수준과 같으면 "적합, 유지", 다르면 그 수준의 추천·대안을 보여 줍니다. 표에 없는 모델에는 추천하지 않습니다. xhigh가 없는 모델(Opus 4.6·Sonnet 4.6)에서는 xhigh 조합을 high로 바꿔 보여 줍니다. `TIER`와 추천표(`TARGETS`)는 가정이며 기록으로 보정할 대상입니다. Opus·high는 "보통" 수준으로 봅니다. 실제 작업 6,758턴(90%가 Opus·high)을 재현해 보니 요구 수준이 대부분 보통이었습니다. Opus·high를 무거움으로 두면 69%의 턴에서 낮추라는 추천이 떴습니다. 그래서 보통 작업에서는 적합, 큰 작업이 몰릴 때만 Opus·xhigh를 추천하게 했습니다. Sonnet·high로 충분했는지는 이 재현으로 확인할 수 없으며, 사용자가 평소 고르는 조합을 보통의 기준으로 삼은 판단입니다. Fable을 맨 위에 둔 근거는 [공식 문서](https://code.claude.com/docs/en/model-config)입니다.
- 두 수준 이상 건너뛰는 추천은 근거가 강할 때만 냅니다: 올릴 때는 반복 실패·수정 후 실패 2회 이상, 내릴 때는 5턴이 다 찼을 때. 아니면 한 수준만 옮깁니다. 내리는 추천은 3턴이 쌓인 뒤부터 냅니다.
- 실패는 도구 결과의 오류 표시로 셉니다. Bash는 오류 표시가 없어도, 명령 뒤에 다른 명령을 붙여 실패가 가려진 경우(`foo; echo "exit=$?"`)를 위해 출력 마지막 줄이 0이 아닌 종료 코드 표기(`exit=127`, `Exit code: 2` 등)이거나 bash의 `…: command not found` 줄이 있으면 실패로 셉니다.
- 실패의 같음은 오류 출력의 첫·마지막 의미 있는 줄로 봅니다(Bash의 `Exit code N` 줄은 무시).
- 서브에이전트 완료 보고로 시작된 턴은 판정에서 뺍니다. 서브에이전트는 대화가 따로라 메인 캐시와 무관하므로 별도 줄로 판정합니다.

## 캐시 영향 표시

모델을 바꾸면 모델마다 캐시가 따로라 다음 요청이 컨텍스트 전체를 캐시 없이 다시 처리합니다. effort는 모델과 제공자에 따라 다릅니다. Opus 5.5·Sonnet 5.5·Haiku 5.5·Fable 5.1을 API 키나 Claude 구독으로 쓰면 effort를 바꿔도 캐시가 유지되고, 그 밖의 모델이나 Amazon Bedrock·Google Cloud Agent Platform 등에서는 캐시가 깨집니다([공식 문서](https://code.claude.com/docs/en/prompt-caching#changing-effort-level)).

그래서 추천과 대안마다 "캐시 유지" 또는 "약 N k 토큰을 캐시 없이 다시 읽음"(마지막 응답의 입력 토큰 기준)을 함께 보여 주고, 캐시가 깨지는 추천이 있으면 compaction 직후(캐시가 어차피 비는 시점)에 토스트로 알립니다.

## 설치

터미널의 Claude Code 프롬프트에서:

```
/plugin install effort-fit --marketplace jesuslim3-prog/effort-fit
```

`Add marketplace?`에 `y`, 그다음 설치 범위를 고릅니다. 데스크톱 앱의 Code 탭에서는 이 명령을 쓸 수 없으니 터미널에서 설치하세요.

개발용으로 폴더에서 바로 띄우려면:

```
claude --plugin-dir <이 저장소를 받은 폴더>
```

## 선택: 로컬 Ollama 분류

`http://127.0.0.1:11434`의 Ollama가 있으면 프롬프트를 light / normal / heavy로 분류해 요구 수준 판정을 보조합니다. 모델 이름은 `hooks/register.tsx`의 `OLLAMA_MODEL`(기본 `qwen3.8:27b`)에서 바꿉니다. Ollama가 없거나 응답하지 않으면 분류 없이 결정론적 신호만으로 동작합니다. 외부 API는 호출하지 않습니다.

## 기록

턴마다 판정 근거를 플러그인 저장소(`~/.claude/plugins/store/` 아래 effort-fit 파일)에 최근 300건까지 남깁니다: `log`(메인 턴), `agentLog`(서브에이전트), `compactLog`(compaction). 턴 항목에는 판정 신호, 요구 수준(`level`), 추천 수준(`target`), 추천 조합(`recommended`)과 함께 세션 ID, `turnId`, 소요 시간, 그 턴의 토큰 합계(입력·출력·캐시 읽기·캐시 쓰기)가 들어갑니다. 모델이나 effort를 바꾼 직후 턴의 캐시 쓰기 토큰을 보면 그 환경에서 캐시가 실제로 깨졌는지 확인할 수 있고, 다음 턴의 모델·effort를 보면 사용자가 추천을 따랐는지 알 수 있습니다. 판정 기준이 실제 작업에 맞는지 나중에 대조하는 용도입니다. 모델에게는 판정 결과를 보내지 않습니다(프롬프트에 넣지 않음).

## 한계

- "적합"을 직접 재는 방법은 없습니다. 위 신호는 모두 대리 지표입니다.
- 실패 감지는 도구 호출의 오류 표시와, Bash의 경우 위의 출력 흔적 두 가지에 의존합니다. 그 밖의 방식으로 실패가 가려지면(예: `|| true`, 종료 코드를 출력하지 않는 `; echo done`) 잡히지 않고, 출력 마지막 줄에 우연히 `exit=1` 같은 글자가 오면 실패로 잘못 셀 수 있습니다.
- 읽기 전용 여부는 Claude Code 자체 판단을 따릅니다. 예를 들어 `find ... | sed` 같은 명령은 읽기 전용으로 잡히지 않습니다.
- 캐시 유지 판단은 모델 이름과 환경 변수(`CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_MANTLE`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`)로 합니다. Claude apps gateway와 HIPAA 구성은 알아낼 수 없어 그 환경에서는 "캐시 유지" 표시가 틀릴 수 있습니다. 그 경우에도 캐시가 살아 있으면 Claude Code가 effort 변경 전에 확인을 묻습니다.
- 최근 5턴 창은 플러그인이 다시 로드되면 비워집니다.

## 개발

```
claude plugin validate .
claude plugin test .
```

판정 로직은 `hooks/judge.ts`, 이벤트 수집과 표시는 `hooks/register.tsx`에 있습니다.

판정 기준을 바꾸기 전에 `tools/replay.mjs`로 기존 Claude Code 대화 기록에 판정을 다시 돌려 보면, 실제 작업에서 패널이 무엇을 보여 줬을지 미리 볼 수 있습니다(Node 23.6 이상, 대화 기록은 읽기만 합니다). 대화 기록에는 읽기 전용 여부와 로컬 분류가 없어 실제 플러그인과 조금 다를 수 있습니다.

```
node --no-warnings tools/replay.mjs rows.json ~/.claude/projects/<프로젝트 폴더>
```

## 라이선스

MIT
