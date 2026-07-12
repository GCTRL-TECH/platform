"""Optional OTel tracing to a SELF-HOSTED Arize Phoenix instance.

OFF by default — spans are only recorded when PHOENIX_OTLP_URL is set (e.g.
``http://host.docker.internal:6006/v1/traces``). Traces contain document text,
prompts and extracted knowledge, so this must only ever point at a self-hosted
Phoenix on the local network, never a cloud collector.

Fail-safe by construction: a missing env var, missing opentelemetry packages or
a broken exporter all degrade to a permanent no-op — tracing must never break
or slow the extraction pipeline. Spans carry OpenInference attributes
(``openinference.span.kind``, ``input.value``/``output.value``,
``llm.model_name``) so Phoenix renders proper CHAIN/LLM/TOOL waterfalls.
"""

import os
from contextlib import contextmanager

_SERVICE = os.environ.get("PHOENIX_SERVICE_NAME", "gctrl-kex")

_tracer = None
_init_state = 0  # 0 = not tried, 1 = enabled, -1 = permanently disabled


def _get_tracer():
    global _tracer, _init_state
    if _init_state == 1:
        return _tracer
    if _init_state == -1:
        return None
    url = (os.environ.get("PHOENIX_OTLP_URL") or "").strip()
    if not url:
        _init_state = -1
        return None
    try:
        from opentelemetry import trace
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor

        provider = TracerProvider(
            resource=Resource.create(
                {
                    "service.name": _SERVICE,
                    # Phoenix groups traces into projects by this resource attribute.
                    "openinference.project.name": (os.environ.get("PHOENIX_PROJECT_NAME") or "gctrl").strip() or "gctrl",
                }
            )
        )
        provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(endpoint=url)))
        trace.set_tracer_provider(provider)
        _tracer = trace.get_tracer(_SERVICE)
        _init_state = 1
        return _tracer
    except Exception:
        _init_state = -1
        return None


class _NoopSpan:
    def set_attribute(self, *_args, **_kwargs):
        pass


_NOOP = _NoopSpan()


def trunc(value, max_len=2000):
    """Cap attribute payloads (documents/prompts) so spans stay lightweight."""
    s = value if isinstance(value, str) else str(value)
    return s[:max_len] + "…" if len(s) > max_len else s


@contextmanager
def span(name, kind="CHAIN", attrs=None):
    """Context-managed span; yields a no-op span object when tracing is off.

    Exceptions propagate unchanged (OTel records them on the span), so the
    pipeline's own try/except degradation paths behave exactly as before.
    """
    tracer = _get_tracer()
    if tracer is None:
        yield _NOOP
        return
    with tracer.start_as_current_span(name) as s:
        try:
            s.set_attribute("openinference.span.kind", kind)
            if attrs:
                for k, v in attrs.items():
                    if v is not None:
                        s.set_attribute(k, trunc(v) if isinstance(v, str) else v)
        except Exception:
            pass
        yield s
