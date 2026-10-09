# effort-fit

> **실험작(Experimental).** 개인 실험으로 만든 Claude Code 플러그인입니다. Claude Code 2.1.295(Windows)에서만 확인했고, 기반이 되는 플러그인 훅 API는 Claude Code 쪽에서 "early access"로 표시돼 있어 다음 버전에서 동작이 깨질 수 있습니다. 판정 기준은 소수의 시험 턴으로 정한 경험칙이며 검증된 지표가 아닙니다.
>
> *Experimental Claude Code plugin that shows whether the session's model and reasoning effort fit the current work. Tested only on Claude Code 2.1.295 (Windows); it relies on an early-access hooks API and may break on later versions.*

Claude Code 세션이 작업하는 동안 지금 모델·effort가 작업에 맞는지 상태줄과 프롬프트 위 띠로 보여 줍니다. **권장만 하고 모델이나 effort를 직접 바꾸지 않습니다.**

```
⚠ effort-fit: Opus 5.5·high ● 유지
⚠ effort-fit: Opus 5.5·high ▲ effort xhigh 권장
⚠ effort-fit: Opus 5.5·high ▼ effort medium 가능
```

## 언제 적용하는가

모델을 바꾸면 모델마다 캐시가 따로라 다음 요청이 컨텍스트 전체를 캐시 없이 다시 처리합니다. 긴 세션에서는 그 한 번의 비용이 아끼는 양보다 클 수 있습니다. effort는 모델과 제공자에 따라 다릅니다. Opus 5.5·Sonnet 5.5·Haiku 5.5·Fable 5.1을 API 키나 Claude 구독으로 쓰면 effort를 바꿔도 캐시가 유지되고, 그 밖의 모델이나 Amazon Bedrock·Google Cloud Agent Platform 등에서는 캐시가 깨집니다([공식 문서](https://code.claude.com/docs/en/prompt-caching#changing-effort-level)).

그래서 캐시를 유지하는 effort 권장에는 "지금 바꿔도 됩니다"를 띄웁니다. 캐시를 깨는 권장(모델 전환 포함)은 쌓아 두었다가 compaction 직후(캐시가 어차피 비는 시점)에 토스트로 알립니다. 판정이 대리 지표라 어느 경우에도 직접 바꾸지는 않습니다. 서브에이전트는 대화가 따로라 메인 캐시와 무관하므로 별도 줄로 판정합니다.

## 판정 규칙

결정론적 신호가 중심이고, 로컬 LLM 분류는 보조입니다.

| 표시 | 조건 |
|---|---|
| ▲ 상향 권장 | 같은 실패가 최근 3턴 안에 다시 나옴, 또는 한 턴에 "수정 후 실패"가 2회 이상. 뜬 턴 포함 3턴 유지(모델·effort를 바꾸면 해제) |
| ▼ 하향 가능 | 4단계 이하·편집 1회 이하·오류 0·읽기 전용 도구만 쓴 턴이 3턴 연속(로컬 분류가 light면 2턴, heavy면 표시 안 함) |
| ● 유지 | 그 밖 |

- 권장값은 effort 사다리(low → medium → high → xhigh → max)를 한 칸 움직이고, 끝에 닿으면 모델(Sonnet ↔ Opus)을 제안합니다.
- 실패의 같음은 오류 출력의 첫·마지막 의미 있는 줄로 봅니다(Bash의 `Exit code N` 줄은 무시).
- 서브에이전트 완료 보고로 시작된 턴은 판정에서 뺍니다.

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

`http://127.0.0.1:11434`의 Ollama가 있으면 프롬프트를 light / normal / heavy로 분류해 ▼ 판정을 보조합니다. 모델 이름은 `hooks/register.tsx`의 `OLLAMA_MODEL`(기본 `qwen3.8:27b`)에서 바꿉니다. Ollama가 없거나 응답하지 않으면 분류 없이 결정론적 신호만으로 동작합니다. 외부 API는 호출하지 않습니다.

## 기록

턴마다 판정 근거를 플러그인 저장소(`~/.claude/plugins/store/` 아래 effort-fit 파일)에 최근 300건까지 남깁니다: `log`(메인 턴), `agentLog`(서브에이전트), `compactLog`(compaction). 턴 항목에는 판정 신호와 함께 세션 ID, `turnId`, 소요 시간, 그 턴의 토큰 합계(입력·출력·캐시 읽기·캐시 쓰기)가 들어갑니다. 모델이나 effort를 바꾼 직후 턴의 캐시 쓰기 토큰을 보면 그 환경에서 캐시가 실제로 깨졌는지 확인할 수 있습니다. 판정 기준이 실제 작업에 맞는지 나중에 대조하는 용도입니다. 모델에게는 판정 결과를 보내지 않습니다(프롬프트에 넣지 않음).

## 한계

- "적합"을 직접 재는 방법은 없습니다. 위 신호는 모두 대리 지표입니다.
- 실패 감지는 도구 호출의 오류 표시에 의존합니다. 모델이 명령 뒤에 `; echo` 같은 것을 붙여 종료 코드를 0으로 만들면 실패로 잡히지 않습니다.
- 읽기 전용 여부는 Claude Code 자체 판단을 따릅니다. 예를 들어 `find ... | sed` 같은 명령은 읽기 전용으로 잡히지 않습니다.
- 캐시 유지 판단은 모델 이름과 환경 변수(`CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_MANTLE`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`)로 합니다. Claude apps gateway와 HIPAA 구성은 알아낼 수 없어 그 환경에서는 "지금 바꿔도 됩니다"가 틀릴 수 있습니다. 그 경우에도 캐시가 살아 있으면 Claude Code가 effort 변경 전에 확인을 묻습니다.
- 연속 턴 수와 ▲ 유지 상태는 플러그인이 다시 로드되면 초기화됩니다.

## 개발

```
claude plugin validate .
claude plugin test .
```

판정 로직은 `hooks/judge.ts`, 이벤트 수집과 표시는 `hooks/register.tsx`에 있습니다.

## 라이선스

MIT
