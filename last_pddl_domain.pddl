(define (domain deliveroo)
  (:requirements :strips :typing)
  (:types agent tile parcel direction)

  (:predicates
    (at ?a - agent ?t - tile)
    (connected ?t1 - tile ?t2 - tile ?dir - direction)
    (free ?t - tile)
    (has-parcel ?a - agent ?p - parcel)
    (parcel-at ?p - parcel ?t - tile)
    (delivery-tile ?t - tile)
    (allowed-entry ?t - tile ?dir - direction)
  )

  (:constants up down left right - direction)

  (:action move-up
    :parameters (?a - agent ?from - tile ?to - tile)
    :precondition (and (at ?a ?from) (connected ?from ?to up) (free ?to) (allowed-entry ?to up))
    :effect (and (not (at ?a ?from)) (at ?a ?to) (not (free ?to)) (free ?from))
  )

  (:action move-down
    :parameters (?a - agent ?from - tile ?to - tile)
    :precondition (and (at ?a ?from) (connected ?from ?to down) (free ?to) (allowed-entry ?to down))
    :effect (and (not (at ?a ?from)) (at ?a ?to) (not (free ?to)) (free ?from))
  )

  (:action move-left
    :parameters (?a - agent ?from - tile ?to - tile)
    :precondition (and (at ?a ?from) (connected ?from ?to left) (free ?to) (allowed-entry ?to left))
    :effect (and (not (at ?a ?from)) (at ?a ?to) (not (free ?to)) (free ?from))
  )

  (:action move-right
    :parameters (?a - agent ?from - tile ?to - tile)
    :precondition (and (at ?a ?from) (connected ?from ?to right) (free ?to) (allowed-entry ?to right))
    :effect (and (not (at ?a ?from)) (at ?a ?to) (not (free ?to)) (free ?from))
  )

  (:action pickup
    :parameters (?a - agent ?p - parcel ?t - tile)
    :precondition (and (at ?a ?t) (parcel-at ?p ?t) (not (has-parcel ?a ?p)))
    :effect (and (has-parcel ?a ?p) (not (parcel-at ?p ?t)))
  )

  (:action deliver
    :parameters (?a - agent ?p - parcel ?t - tile)
    :precondition (and (at ?a ?t) (has-parcel ?a ?p) (delivery-tile ?t))
    :effect (and (not (has-parcel ?a ?p)))
  )
)
