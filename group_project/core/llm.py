from langchain_ollama import ChatOllama
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.output_parsers import StrOutputParser

# The local Ollama model name.
# Change this if you pulled a different model.
OLLAMA_MODEL = "qwen3:8b"

# Initialize the model once at import time.
_model = ChatOllama(
    model=OLLAMA_MODEL,
    temperature=0,
)

# Basic prompt template: system instruction + user question.
_prompt = ChatPromptTemplate.from_messages(
    [
        ("system", "You are a helpful assistant. Always respond in the same language as the user's question."),
        ("human", "{question}"),
    ]
)

# Simple chain: prompt -> model -> plain string output.
_chain = _prompt | _model | StrOutputParser()


async def stream_response(question: str):
    """Yield response chunks from the local Ollama model."""
    async for chunk in _chain.astream({"question": question}):
        yield chunk