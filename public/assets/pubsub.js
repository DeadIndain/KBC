(() => {
	function parseJsonResponse(response) {
		return response
			.json()
			.catch(() => ({}))
			.then((payload) => ({ payload, response }));
	}

	window.createPubSubClient = function createPubSubClient() {
		const listeners = new Map();
		const source = new EventSource("/events");

		function dispatch(eventName, payload) {
			const handlers = listeners.get(eventName) || [];
			handlers.forEach((handler) => {
				try {
					handler(payload);
				} catch (error) {
					console.error(`PubSub handler failed for ${eventName}:`, error);
				}
			});
		}

		source.addEventListener("state", (event) => {
			dispatch("state", JSON.parse(event.data));
		});

		source.addEventListener("questions-meta", (event) => {
			dispatch("questions-meta", JSON.parse(event.data));
		});

		source.addEventListener("play-sound", (event) => {
			dispatch("play-sound", JSON.parse(event.data));
		});

		source.addEventListener("error", (event) => {
			dispatch("error", event);
		});

		return {
			on(eventName, handler) {
				const handlers = listeners.get(eventName) || [];
				handlers.push(handler);
				listeners.set(eventName, handlers);
				return () => {
					const nextHandlers = (listeners.get(eventName) || []).filter(
						(existingHandler) => existingHandler !== handler,
					);
					if (nextHandlers.length > 0) {
						listeners.set(eventName, nextHandlers);
					} else {
						listeners.delete(eventName);
					}
				};
			},
			emit(eventName, payload = {}, callback) {
				const request = fetch(`/api/command/${encodeURIComponent(eventName)}`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
					},
					body: JSON.stringify(payload),
				}).then(async (response) => {
					const { payload: data } = await parseJsonResponse(response);
					const result =
						data && Object.keys(data).length ? data : { ok: response.ok };
					if (!response.ok) {
						throw new Error(
							result.message || `Request failed (${response.status})`,
						);
					}
					return result;
				});

				if (typeof callback === "function") {
					request.then(callback).catch((error) => {
						callback({ ok: false, message: error.message });
					});
				}

				return request;
			},
			close() {
				source.close();
			},
		};
	};
})();
